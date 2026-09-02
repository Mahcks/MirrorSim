pub const UPDATER_ENDPOINT: &str =
    "https://github.com/Mahcks/MirrorSim/releases/latest/download/latest.json";

pub const UPDATER_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEJBOThGM0E1QzJDRjQ2REMKUldUY1JzL0NwZk9ZdXNJWmx2TTNDNlR5NGhxdmwwbE5taFdFZ1FzSzRFQUhIeVRwUk5uMkJqRDMK";

pub fn updater_is_configured() -> bool {
    !UPDATER_PUBKEY.trim().is_empty()
}

#[cfg(test)]
mod tests {
    use super::{UPDATER_ENDPOINT, UPDATER_PUBKEY};

    #[test]
    fn runtime_updater_config_matches_tauri_bundle_config() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri config json");
        let updater = &config["plugins"]["updater"];

        assert_eq!(updater["pubkey"].as_str(), Some(UPDATER_PUBKEY));
        assert_eq!(updater["endpoints"][0].as_str(), Some(UPDATER_ENDPOINT));
    }
}
