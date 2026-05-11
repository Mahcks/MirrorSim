pub const UPDATER_ENDPOINT: &str =
    "https://github.com/Mahcks/MirrorSim/releases/latest/download/latest.json";

pub const UPDATER_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEJBOThGM0E1QzJDRjQ2REMKUldUY1JzL0NwZk9ZdXNJWmx2TTNDNlR5NGhxdmwwbE5taFdFZ1FzSzRFQUhIeVRwUk5uMkJqRDMK";

pub fn updater_is_configured() -> bool {
    !UPDATER_PUBKEY.trim().is_empty()
}
