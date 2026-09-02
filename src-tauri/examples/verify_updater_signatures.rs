use base64::prelude::{Engine as _, BASE64_STANDARD};
use minisign_verify::{PublicKey, Signature};
use std::path::{Path, PathBuf};

fn decode_embedded_public_key() -> Result<PublicKey, String> {
    let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .map_err(|error| format!("could not parse tauri.conf.json: {error}"))?;
    let encoded = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| String::from("tauri.conf.json is missing the updater public key"))?;
    let decoded = BASE64_STANDARD
        .decode(encoded.trim())
        .map_err(|error| format!("updater public key is not valid base64: {error}"))?;
    let decoded = String::from_utf8(decoded)
        .map_err(|error| format!("updater public key is not valid UTF-8: {error}"))?;
    PublicKey::decode(&decoded)
        .map_err(|error| format!("updater public key is not valid minisign data: {error}"))
}

fn signature_path(artifact: &Path) -> PathBuf {
    let mut value = artifact.as_os_str().to_os_string();
    value.push(".sig");
    PathBuf::from(value)
}

fn verify_artifact(public_key: &PublicKey, artifact: &Path) -> Result<(), String> {
    if !artifact.is_file() {
        return Err(format!(
            "updater artifact does not exist: {}",
            artifact.display()
        ));
    }

    let signature_path = signature_path(artifact);
    let encoded_signature = std::fs::read_to_string(&signature_path).map_err(|error| {
        format!(
            "could not read updater signature '{}': {error}",
            signature_path.display()
        )
    })?;
    let decoded_signature = BASE64_STANDARD
        .decode(encoded_signature.trim())
        .map_err(|error| {
            format!(
                "updater signature '{}' is not valid base64: {error}",
                signature_path.display()
            )
        })?;
    let decoded_signature = String::from_utf8(decoded_signature).map_err(|error| {
        format!(
            "updater signature '{}' is not valid UTF-8: {error}",
            signature_path.display()
        )
    })?;
    let signature = Signature::decode(&decoded_signature).map_err(|error| {
        format!(
            "updater signature '{}' is not valid minisign data: {error}",
            signature_path.display()
        )
    })?;
    let payload = std::fs::read(artifact).map_err(|error| {
        format!(
            "could not read updater artifact '{}': {error}",
            artifact.display()
        )
    })?;
    public_key
        .verify(&payload, &signature, false)
        .map_err(|error| {
            format!(
                "updater signature '{}' does not match the embedded public key: {error}",
                signature_path.display()
            )
        })
}

fn run() -> Result<(), String> {
    let artifacts = std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    if artifacts.is_empty() {
        return Err(String::from(
            "provide at least one updater artifact path; each must have a sibling .sig file",
        ));
    }

    let public_key = decode_embedded_public_key()?;
    for artifact in artifacts {
        verify_artifact(&public_key, &artifact)?;
        let artifact = artifact.display();
        println!("Verified updater signature for {artifact}");
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Updater signature verification failed: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_embedded_public_key, signature_path};
    use std::path::Path;

    #[test]
    fn embedded_updater_public_key_decodes() {
        decode_embedded_public_key().expect("embedded updater public key");
    }

    #[test]
    fn signature_path_appends_without_replacing_the_installer_extension() {
        assert_eq!(
            signature_path(Path::new("MirrorSim-setup.exe")),
            Path::new("MirrorSim-setup.exe.sig")
        );
    }
}
