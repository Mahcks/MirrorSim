use crate::models::{BonjourStatusKind, BonjourStatusSnapshot, CommandResult};
use crate::persistence::durable_replace;
use mdns_sd::{ServiceDaemon, ServiceInfo};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

const RAOP_PORT: u16 = 5001;
const AIRPLAY_PORT: u16 = 7001;
const IDENTITY_FILE: &str = "receiver-discovery-id-v2.bin";

#[derive(Default)]
pub(crate) struct DiscoveryRuntime {
    daemon: Option<ServiceDaemon>,
    fullnames: Vec<String>,
    receiver_name: Option<String>,
    last_error: Option<String>,
    pending: Option<(String, [u8; 6])>,
    ports: Option<(u16, u16)>,
    dynamic_ports: Option<bool>,
}

impl DiscoveryRuntime {
    fn record_error(&mut self, error: &str) {
        self.unregister();
        self.last_error = Some(error.to_string());
    }

    fn unregister(&mut self) {
        if let Some(daemon) = self.daemon.as_ref() {
            for fullname in self.fullnames.drain(..) {
                let _ = daemon.unregister(&fullname);
            }
        }
        self.receiver_name = None;
    }

    fn stop(&mut self) {
        self.unregister();
        self.pending = None;
        if self.dynamic_ports != Some(false) {
            self.ports = None;
        }
        self.last_error = None;
    }

    fn start(&mut self, receiver_name: &str, hardware_address: [u8; 6]) -> CommandResult<()> {
        self.pending = Some((receiver_name.to_string(), hardware_address));
        if self.ports.is_none() {
            // Do not advertise until the receiver has bound its listening sockets.
            return Ok(());
        }
        if self.receiver_name.as_deref() == Some(receiver_name) && self.fullnames.len() == 2 {
            self.last_error = None;
            return Ok(());
        }

        self.unregister();
        let result = self.register(receiver_name, hardware_address);
        match result {
            Ok(()) => {
                self.last_error = None;
                Ok(())
            }
            Err(error) => {
                self.last_error = Some(error.clone());
                Err(error)
            }
        }
    }

    fn restart(&mut self, receiver_name: &str, hardware_address: [u8; 6]) -> CommandResult<()> {
        self.unregister();
        if let Some(daemon) = self.daemon.take() {
            let _ = daemon.shutdown();
        }
        self.start(receiver_name, hardware_address)
    }

    fn register(&mut self, receiver_name: &str, hardware_address: [u8; 6]) -> CommandResult<()> {
        let (raop_port, airplay_port) = self.ports.ok_or("receiver ports are not ready")?;
        let daemon = match self.daemon.as_ref() {
            Some(daemon) => daemon,
            None => {
                self.daemon = Some(ServiceDaemon::new().map_err(|error| {
                    format!("could not start built-in AirPlay discovery: {error}")
                })?);
                self.daemon
                    .as_ref()
                    .expect("discovery daemon was initialized")
            }
        };

        let compact_id = compact_hardware_address(hardware_address);
        let display_id = display_hardware_address(hardware_address);
        let host_name = format!("mirrorsim-{}.local.", &compact_id[6..]);
        let raop_instance = format!("{compact_id}@{receiver_name}");
        let raop_properties = [
            ("txtvers", "1"),
            ("ch", "2"),
            ("cn", "0,1,3"),
            ("et", "0,3,5"),
            ("sv", "false"),
            ("da", "true"),
            ("sr", "44100"),
            ("ss", "16"),
            ("pw", "false"),
            ("vn", "3"),
            ("tp", "TCP,UDP"),
            ("md", "0,1,2"),
            ("vs", "845.5.1"),
            ("sm", "false"),
            ("ek", "1"),
            ("sf", "0x4"),
            ("am", "AppleTV14,1"),
        ];
        let airplay_properties = vec![
            ("srcvers", String::from("845.5.1")),
            ("deviceid", display_id),
            ("features", String::from("0x5A7FFEE6,0x0")),
            ("model", String::from("AppleTV14,1")),
            ("flags", String::from("0x4")),
            ("vv", String::from("2")),
        ];

        let raop = ServiceInfo::new(
            "_raop._tcp.local.",
            &raop_instance,
            &host_name,
            "",
            raop_port,
            &raop_properties[..],
        )
        .map_err(|error| format!("could not configure AirPlay audio discovery: {error}"))?
        .enable_addr_auto();
        let airplay = ServiceInfo::new(
            "_airplay._tcp.local.",
            receiver_name,
            &host_name,
            "",
            airplay_port,
            &airplay_properties[..],
        )
        .map_err(|error| format!("could not configure AirPlay screen discovery: {error}"))?
        .enable_addr_auto();

        let raop_fullname = raop.get_fullname().to_string();
        let airplay_fullname = airplay.get_fullname().to_string();
        daemon
            .register(raop)
            .map_err(|error| format!("could not advertise AirPlay audio service: {error}"))?;
        if let Err(error) = daemon.register(airplay) {
            let _ = daemon.unregister(&raop_fullname);
            return Err(format!(
                "could not advertise AirPlay screen service: {error}"
            ));
        }

        self.fullnames = vec![raop_fullname, airplay_fullname];
        self.receiver_name = Some(receiver_name.to_string());
        Ok(())
    }

    fn status(&self) -> BonjourStatusSnapshot {
        let service_name = self
            .receiver_name
            .clone()
            .unwrap_or_else(|| String::from("MirrorSim Discovery"));
        if let Some(error) = self.last_error.as_deref() {
            return BonjourStatusSnapshot {
                status: BonjourStatusKind::Missing,
                service_name,
                detail: format!(
                    "Built-in AirPlay discovery could not advertise this receiver: {error}"
                ),
            };
        }
        if self.daemon.is_some() && self.fullnames.len() == 2 {
            return BonjourStatusSnapshot {
                status: BonjourStatusKind::Ready,
                service_name,
                detail: String::from(
                    "Built-in AirPlay discovery is advertising on active network interfaces.",
                ),
            };
        }
        BonjourStatusSnapshot {
            status: BonjourStatusKind::Stopped,
            service_name,
            detail: String::from(
                "Discovery is stopped and will begin when MirrorSim starts listening.",
            ),
        }
    }
}

impl Drop for DiscoveryRuntime {
    fn drop(&mut self) {
        self.stop();
        if let Some(daemon) = self.daemon.take() {
            let _ = daemon.shutdown();
        }
    }
}

pub(crate) fn start_discovery(
    app: &AppHandle,
    runtime: &Arc<Mutex<DiscoveryRuntime>>,
    requested_name: Option<&str>,
) -> CommandResult<()> {
    let receiver_name = normalized_receiver_name(requested_name);
    let hardware_address = match receiver_hardware_address(app) {
        Ok(address) => address,
        Err(error) => {
            if let Ok(mut runtime) = runtime.lock() {
                runtime.record_error(&error);
            }
            return Err(error);
        }
    };
    runtime
        .lock()
        .map_err(|error| error.to_string())?
        .start(&receiver_name, hardware_address)
}

pub(crate) fn refresh_discovery(
    app: &AppHandle,
    runtime: &Arc<Mutex<DiscoveryRuntime>>,
    requested_name: Option<&str>,
) -> CommandResult<()> {
    let receiver_name = normalized_receiver_name(requested_name);
    let hardware_address = match receiver_hardware_address(app) {
        Ok(address) => address,
        Err(error) => {
            if let Ok(mut runtime) = runtime.lock() {
                runtime.record_error(&error);
            }
            return Err(error);
        }
    };
    runtime
        .lock()
        .map_err(|error| error.to_string())?
        .restart(&receiver_name, hardware_address)
}

pub(crate) fn discovery_status(runtime: &Arc<Mutex<DiscoveryRuntime>>) -> BonjourStatusSnapshot {
    match runtime.lock() {
        Ok(runtime) => runtime.status(),
        Err(error) => BonjourStatusSnapshot {
            status: BonjourStatusKind::Unknown,
            service_name: String::from("MirrorSim Discovery"),
            detail: format!("Built-in AirPlay discovery state is unavailable: {error}"),
        },
    }
}

pub(crate) fn stop_discovery(runtime: &Arc<Mutex<DiscoveryRuntime>>) {
    if let Ok(mut runtime) = runtime.lock() {
        runtime.stop();
    }
}

pub(crate) fn reset_discovery_listener(runtime: &Arc<Mutex<DiscoveryRuntime>>) {
    if let Ok(mut runtime) = runtime.lock() {
        runtime.unregister();
        runtime.ports = None;
        runtime.dynamic_ports = None;
    }
}

pub(crate) fn set_discovery_protocol(
    runtime: &Arc<Mutex<DiscoveryRuntime>>,
    dynamic_ports: bool,
) -> CommandResult<()> {
    runtime
        .lock()
        .map_err(|error| error.to_string())?
        .dynamic_ports = Some(dynamic_ports);
    if !dynamic_ports {
        set_discovery_ports(runtime, RAOP_PORT, AIRPLAY_PORT)?;
    }
    Ok(())
}

pub(crate) fn set_discovery_ports(
    runtime: &Arc<Mutex<DiscoveryRuntime>>,
    raop_port: u16,
    airplay_port: u16,
) -> CommandResult<()> {
    if raop_port == 0 || airplay_port == 0 || raop_port == airplay_port {
        return Err(String::from("receiver reported invalid listening ports"));
    }
    let mut runtime = runtime.lock().map_err(|error| error.to_string())?;
    if runtime.ports != Some((raop_port, airplay_port)) {
        runtime.unregister();
    }
    runtime.ports = Some((raop_port, airplay_port));
    if let Some((name, address)) = runtime.pending.clone() {
        runtime.start(&name, address)?;
    }
    Ok(())
}

pub(crate) fn receiver_hardware_address_hex(app: &AppHandle) -> CommandResult<String> {
    Ok(compact_hardware_address(receiver_hardware_address(app)?))
}

fn normalized_receiver_name(requested_name: Option<&str>) -> String {
    let name = requested_name
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("MirrorSim");
    let mut normalized = name
        .chars()
        .filter(|character| !character.is_control())
        .take(48)
        .collect::<String>();
    if normalized.trim().is_empty() {
        normalized = String::from("MirrorSim");
    }
    normalized
}

fn receiver_hardware_address(app: &AppHandle) -> CommandResult<[u8; 6]> {
    let identity_path = identity_file_path(app)?;
    if let Ok(bytes) = fs::read(&identity_path) {
        if let Some(address) = valid_receiver_identity(&bytes) {
            return Ok(address);
        }
    }

    let address = random_receiver_identity()?;
    let backup_path = identity_path.with_extension("bin.bak");
    durable_replace(&identity_path, &backup_path, &address)
        .map_err(|error| format!("could not save the receiver discovery identity: {error}"))?;
    Ok(address)
}

fn identity_file_path(app: &AppHandle) -> CommandResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(IDENTITY_FILE))
        .map_err(|error| error.to_string())
}

fn compact_hardware_address(address: [u8; 6]) -> String {
    address
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<String>()
}

fn display_hardware_address(address: [u8; 6]) -> String {
    address
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn valid_receiver_identity(bytes: &[u8]) -> Option<[u8; 6]> {
    let address = <[u8; 6]>::try_from(bytes).ok()?;
    (address.iter().any(|byte| *byte != 0) && address[0] & 0x01 == 0 && address[0] & 0x02 != 0)
        .then_some(address)
}

fn random_receiver_identity() -> CommandResult<[u8; 6]> {
    let mut address = [0u8; 6];
    getrandom::fill(&mut address)
        .map_err(|error| format!("could not generate a private receiver identity: {error}"))?;
    // Use a locally administered, unicast address. It identifies this MirrorSim
    // installation without exposing a physical network adapter address.
    address[0] = (address[0] | 0x02) & 0xfe;
    Ok(address)
}

#[cfg(test)]
mod tests {
    use super::{
        compact_hardware_address, display_hardware_address, normalized_receiver_name,
        random_receiver_identity, valid_receiver_identity, DiscoveryRuntime,
    };
    use crate::models::BonjourStatusKind;

    #[test]
    fn formats_discovery_identity_for_both_airplay_records() {
        let address = [0x02, 0x10, 0xab, 0xcd, 0xef, 0x05];
        assert_eq!(compact_hardware_address(address), "0210ABCDEF05");
        assert_eq!(display_hardware_address(address), "02:10:AB:CD:EF:05");
    }

    #[test]
    fn normalizes_empty_and_control_character_receiver_names() {
        assert_eq!(normalized_receiver_name(Some("  ")), "MirrorSim");
        assert_eq!(normalized_receiver_name(Some("Living\nRoom")), "LivingRoom");
    }

    #[test]
    fn generated_identity_is_private_unicast_and_valid() {
        let address = random_receiver_identity().expect("receiver identity should be generated");
        assert_eq!(address[0] & 0x01, 0);
        assert_ne!(address[0] & 0x02, 0);
        assert_eq!(valid_receiver_identity(&address), Some(address));
        assert_eq!(valid_receiver_identity(&[0; 6]), None);
        assert_eq!(valid_receiver_identity(&[0x01, 2, 3, 4, 5, 6]), None);
    }

    #[test]
    fn discovery_status_tracks_stopped_ready_and_stopped_again() {
        let mut runtime = DiscoveryRuntime::default();
        runtime.ports.replace((5001, 7001));
        assert_eq!(runtime.status().status, BonjourStatusKind::Stopped);
        runtime
            .start(
                "MirrorSim Status Test",
                [0x02, 0x10, 0xab, 0xcd, 0xef, 0x06],
            )
            .expect("built-in discovery should start");
        assert_eq!(runtime.status().status, BonjourStatusKind::Ready);
        runtime.stop();
        assert_eq!(runtime.status().status, BonjourStatusKind::Stopped);
    }

    #[test]
    fn discovery_status_preserves_registration_failures() {
        let mut runtime = DiscoveryRuntime::default();
        runtime.record_error("simulated registration failure");
        let status = runtime.status();
        assert_eq!(status.status, BonjourStatusKind::Missing);
        assert!(status.detail.contains("simulated registration failure"));
    }

    #[test]
    fn built_in_discovery_registers_both_airplay_services() {
        let mut runtime = DiscoveryRuntime::default();
        runtime.ports.replace((5001, 7001));
        runtime
            .start(
                "MirrorSim Discovery Test",
                [0x02, 0x10, 0xab, 0xcd, 0xef, 0x05],
            )
            .expect("built-in discovery should register its AirPlay services");
        assert_eq!(runtime.fullnames.len(), 2);
        assert_eq!(
            runtime.receiver_name.as_deref(),
            Some("MirrorSim Discovery Test")
        );
        runtime.stop();
    }

    #[test]
    fn discovery_waits_for_bound_ports_and_forgets_them_on_stop() {
        use super::{set_discovery_ports, set_discovery_protocol};
        use std::sync::{Arc, Mutex};
        let runtime = Arc::new(Mutex::new(DiscoveryRuntime::default()));
        set_discovery_protocol(&runtime, true).unwrap();
        runtime
            .lock()
            .unwrap()
            .start("MirrorSim Dynamic Test", [2, 1, 2, 3, 4, 5])
            .unwrap();
        assert!(runtime.lock().unwrap().fullnames.is_empty());
        assert!(set_discovery_ports(&runtime, 0, 7001).is_err());
        assert!(set_discovery_ports(&runtime, 5001, 5001).is_err());
        set_discovery_ports(&runtime, 51001, 51002).unwrap();
        assert_eq!(runtime.lock().unwrap().ports, Some((51001, 51002)));
        assert_eq!(runtime.lock().unwrap().fullnames.len(), 2);
        runtime.lock().unwrap().stop();
        assert!(runtime.lock().unwrap().ports.is_none());
        // A late acknowledgement after stop must never resurrect advertisement.
        set_discovery_ports(&runtime, 51003, 51004).unwrap();
        assert!(runtime.lock().unwrap().fullnames.is_empty());
    }

    #[test]
    fn legacy_receiver_and_crash_restart_keep_discovery_compatible() {
        use super::{reset_discovery_listener, set_discovery_ports, set_discovery_protocol};
        use std::sync::{Arc, Mutex};
        let runtime = Arc::new(Mutex::new(DiscoveryRuntime::default()));
        runtime
            .lock()
            .unwrap()
            .start("MirrorSim Legacy Test", [2, 1, 2, 3, 4, 6])
            .unwrap();
        set_discovery_protocol(&runtime, false).unwrap();
        assert_eq!(runtime.lock().unwrap().ports, Some((5001, 7001)));
        assert_eq!(runtime.lock().unwrap().fullnames.len(), 2);
        reset_discovery_listener(&runtime);
        assert!(runtime.lock().unwrap().fullnames.is_empty());
        set_discovery_protocol(&runtime, true).unwrap();
        set_discovery_ports(&runtime, 51005, 51006).unwrap();
        assert_eq!(runtime.lock().unwrap().fullnames.len(), 2);
    }
}
