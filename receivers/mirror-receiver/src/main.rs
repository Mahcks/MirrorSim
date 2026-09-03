use serde::{Deserialize, Serialize};
use std::{
    env,
    io::{self, BufRead, Write},
    process::{Child, Command, Stdio},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BackendMode {
    Stub,
    AirPlayServer,
}

#[derive(Debug, PartialEq, Eq)]
struct CliOptions {
    backend: BackendMode,
    airplayserver_exe: Option<String>,
    airplayserver_args: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "name", rename_all = "snake_case")]
enum SidecarCommand {
    StartSession {
        session_id: String,
        device_hint: Option<String>,
        expected_stream_id: String,
    },
    StopSession {
        session_id: String,
    },
    RequestKeyframe {
        stream_id: String,
        reason: String,
    },
    Shutdown {},
}

#[derive(Serialize)]
#[serde(tag = "name", rename_all = "snake_case")]
enum SidecarEvent {
    ReceiverReady {
        receiver_id: String,
        protocol_version: String,
        capabilities: Vec<String>,
    },
    SessionStarted {
        session_id: String,
        stream_id: String,
        device_name: String,
    },
    StreamDiscontinuity {
        stream_id: String,
        reason: String,
        requires_init_segment_refresh: bool,
    },
    ReceiverError {
        code: String,
        message: String,
        recoverable: bool,
    },
}

struct SessionState {
    active_stream_id: Option<String>,
}

impl SessionState {
    fn new() -> Self {
        Self {
            active_stream_id: None,
        }
    }
}

struct BackendRuntime {
    mode: BackendMode,
    child: Option<Child>,
}

impl BackendRuntime {
    fn start(options: &CliOptions) -> io::Result<Self> {
        match options.backend {
            BackendMode::Stub => Ok(Self {
                mode: BackendMode::Stub,
                child: None,
            }),
            BackendMode::AirPlayServer => {
                let executable = options.airplayserver_exe.as_deref().ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "missing required --airplayserver-exe for airplayserver backend",
                    )
                })?;

                let child = Command::new(executable)
                    .args(&options.airplayserver_args)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()?;

                Ok(Self {
                    mode: BackendMode::AirPlayServer,
                    child: Some(child),
                })
            }
        }
    }

    fn receiver_id(&self) -> &'static str {
        match self.mode {
            BackendMode::Stub => "mirror-receiver-stub",
            BackendMode::AirPlayServer => "airplayserver-adapter",
        }
    }

    fn capabilities(&self) -> Vec<String> {
        let mut capabilities = vec![
            String::from("stdio-jsonl"),
            String::from("session-control"),
            String::from("discontinuity-events"),
        ];

        if self.mode == BackendMode::AirPlayServer {
            capabilities.push(String::from("native-receiver-process"));
        }

        capabilities
    }

    fn default_device_name(&self) -> &'static str {
        match self.mode {
            BackendMode::Stub => "Stub iPhone",
            BackendMode::AirPlayServer => "AirPlay receiver",
        }
    }

    fn shutdown(&mut self) {
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn parse_cli_args<I>(args: I) -> Result<CliOptions, String>
where
    I: IntoIterator<Item = String>,
{
    let mut backend = BackendMode::Stub;
    let mut airplayserver_exe = None;
    let mut airplayserver_args = Vec::new();

    let mut iter = args.into_iter();
    let _ = iter.next();

    while let Some(argument) = iter.next() {
        match argument.as_str() {
            "--backend" => {
                let value = iter
                    .next()
                    .ok_or_else(|| String::from("missing backend value after --backend"))?;
                backend = match value.as_str() {
                    "stub" => BackendMode::Stub,
                    "airplayserver" => BackendMode::AirPlayServer,
                    other => {
                        return Err(format!("unsupported backend '{other}'"));
                    }
                };
            }
            "--airplayserver-exe" => {
                airplayserver_exe = Some(iter.next().ok_or_else(|| {
                    String::from("missing executable path after --airplayserver-exe")
                })?);
            }
            "--airplayserver-arg" => {
                airplayserver_args.push(iter.next().ok_or_else(|| {
                    String::from("missing argument value after --airplayserver-arg")
                })?);
            }
            "--transport" => {
                let _ = iter
                    .next()
                    .ok_or_else(|| String::from("missing transport value after --transport"))?;
            }
            other => {
                return Err(format!("unsupported argument '{other}'"));
            }
        }
    }

    Ok(CliOptions {
        backend,
        airplayserver_exe,
        airplayserver_args,
    })
}

fn emit_event(event: SidecarEvent) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, &event).map_err(io::Error::other)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn emit_receiver_ready(runtime: &BackendRuntime) -> io::Result<()> {
    emit_event(SidecarEvent::ReceiverReady {
        receiver_id: String::from(runtime.receiver_id()),
        protocol_version: String::from("0.8.0"),
        capabilities: runtime.capabilities(),
    })
}

fn run() -> io::Result<()> {
    let options = parse_cli_args(env::args())
        .map_err(|message| io::Error::new(io::ErrorKind::InvalidInput, message))?;
    let mut runtime = BackendRuntime::start(&options)?;
    let mut session_state = SessionState::new();

    emit_receiver_ready(&runtime)?;

    let stdin = io::stdin();
    let mut locked = stdin.lock();
    let mut line = String::new();

    loop {
        line.clear();
        let bytes_read = locked.read_line(&mut line)?;

        if bytes_read == 0 {
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let command = match serde_json::from_str::<SidecarCommand>(trimmed) {
            Ok(command) => command,
            Err(error) => {
                emit_event(SidecarEvent::ReceiverError {
                    code: String::from("invalid_command"),
                    message: format!("Failed to parse command: {error}"),
                    recoverable: true,
                })?;
                continue;
            }
        };

        match command {
            SidecarCommand::StartSession {
                session_id,
                device_hint,
                expected_stream_id,
            } => {
                session_state.active_stream_id = Some(expected_stream_id.clone());

                emit_event(SidecarEvent::SessionStarted {
                    session_id,
                    stream_id: expected_stream_id,
                    device_name: device_hint
                        .unwrap_or_else(|| String::from(runtime.default_device_name())),
                })?;
            }
            SidecarCommand::StopSession { session_id } => {
                emit_event(SidecarEvent::StreamDiscontinuity {
                    stream_id: session_state.active_stream_id.take().unwrap_or(session_id),
                    reason: String::from("session_stopped"),
                    requires_init_segment_refresh: false,
                })?;
            }
            SidecarCommand::RequestKeyframe { stream_id, reason } => {
                emit_event(SidecarEvent::StreamDiscontinuity {
                    stream_id,
                    reason,
                    requires_init_segment_refresh: false,
                })?;
            }
            SidecarCommand::Shutdown {} => {
                runtime.shutdown();
                break;
            }
        }
    }

    runtime.shutdown();

    Ok(())
}

fn main() {
    if let Err(error) = run() {
        let _ = emit_event(SidecarEvent::ReceiverError {
            code: String::from("sidecar_io_failure"),
            message: error.to_string(),
            recoverable: false,
        });
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_cli_args, BackendMode, SidecarCommand};

    #[test]
    fn parses_airplayserver_backend_arguments() {
        let options = parse_cli_args(vec![
            String::from("mirror-receiver"),
            String::from("--backend"),
            String::from("airplayserver"),
            String::from("--airplayserver-exe"),
            String::from("C:/tools/AirPlayServer.exe"),
            String::from("--airplayserver-arg"),
            String::from("/config"),
        ])
        .expect("airplayserver args should parse");

        assert_eq!(options.backend, BackendMode::AirPlayServer);
        assert_eq!(
            options.airplayserver_exe.as_deref(),
            Some("C:/tools/AirPlayServer.exe")
        );
        assert_eq!(options.airplayserver_args, vec![String::from("/config")]);
    }

    #[test]
    fn start_session_command_parses() {
        let payload = r#"{"name":"start_session","session_id":"session-1","device_hint":"iPhone 15 Pro","expected_stream_id":"fixture-preview-stream"}"#;
        let command: SidecarCommand =
            serde_json::from_str(payload).expect("start_session should parse");

        match command {
            SidecarCommand::StartSession {
                session_id,
                device_hint,
                expected_stream_id,
            } => {
                assert_eq!(session_id, "session-1");
                assert_eq!(device_hint.as_deref(), Some("iPhone 15 Pro"));
                assert_eq!(expected_stream_id, "fixture-preview-stream");
            }
            other => panic!("unexpected command parsed: {other:?}"),
        }
    }
}
