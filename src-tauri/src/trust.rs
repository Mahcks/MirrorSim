#![allow(clippy::too_many_arguments)] // Receiver identity fields mirror the external protocol.

use crate::models::{CommandResult, SessionSnapshot, TrustedDevice};
use crate::persistence::durable_replace;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::history::now_unix_timestamp;

const TRUST_REGISTRY_FILE: &str = "trusted-devices.json";
static TRUST_REGISTRY_LOCK: Mutex<()> = Mutex::new(());

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrustedDeviceRegistry {
    devices: Vec<TrustedDevice>,
}

fn trust_registry_path(app: &AppHandle) -> CommandResult<PathBuf> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(app_data_dir.join(TRUST_REGISTRY_FILE))
}

fn load_registry(app: &AppHandle) -> CommandResult<TrustedDeviceRegistry> {
    let file_path = trust_registry_path(app)?;
    if !file_path.exists() {
        let backup_path = file_path.with_extension("json.bak");
        if !backup_path.exists() {
            return Ok(TrustedDeviceRegistry::default());
        }
        let backup = fs::read_to_string(backup_path).map_err(|error| error.to_string())?;
        return serde_json::from_str::<TrustedDeviceRegistry>(&backup)
            .map_err(|error| error.to_string());
    }

    let contents = fs::read_to_string(&file_path).map_err(|error| error.to_string())?;
    serde_json::from_str::<TrustedDeviceRegistry>(&contents)
        .or_else(|primary_error| {
            let backup_path = file_path.with_extension("json.bak");
            let backup = fs::read_to_string(backup_path).map_err(|_| primary_error)?;
            serde_json::from_str::<TrustedDeviceRegistry>(&backup)
        })
        .map_err(|error| error.to_string())
}

fn save_registry(app: &AppHandle, registry: &TrustedDeviceRegistry) -> CommandResult<()> {
    let file_path = trust_registry_path(app)?;
    let payload = serde_json::to_vec_pretty(registry).map_err(|error| error.to_string())?;
    let backup_path = file_path.with_extension("json.bak");
    durable_replace(&file_path, &backup_path, &payload)
}

fn display_label(device: &TrustedDevice) -> String {
    device
        .nickname
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&device.display_name)
        .to_string()
}

fn is_device_trusted(device: &TrustedDevice) -> bool {
    device.trusted_at.is_some() && !device.is_blocked
}

fn is_authenticated_fingerprint(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_legacy_network_identity(value: &str) -> bool {
    let segments = value.split(':').collect::<Vec<_>>();
    segments.len() == 6
        && segments.iter().all(|segment| {
            segment.len() == 2 && segment.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

fn migrate_legacy_trusted_identity(
    registry: &mut TrustedDeviceRegistry,
    device_name: &str,
    device_id: Option<&str>,
) {
    let Some(authenticated_id) = device_id
        .map(str::trim)
        .filter(|value| is_authenticated_fingerprint(value))
    else {
        return;
    };
    let authenticated_key = authenticated_id.to_ascii_lowercase();

    if registry
        .devices
        .iter()
        .any(|device| device.key == authenticated_key)
    {
        return;
    }

    let matching_legacy_indexes = registry
        .devices
        .iter()
        .enumerate()
        .filter(|(_, device)| {
            is_device_trusted(device)
                && is_legacy_network_identity(&device.key)
                && device
                    .display_name
                    .trim()
                    .eq_ignore_ascii_case(device_name.trim())
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();

    // The user has explicitly approved this authenticated identity. Re-key a
    // single unambiguous legacy record so upgrades preserve its nickname and
    // history without silently transferring trust between similarly named phones.
    if let [index] = matching_legacy_indexes.as_slice() {
        let device = &mut registry.devices[*index];
        device.key = authenticated_key;
        device.device_id = Some(authenticated_id.to_string());
    }
}

fn apply_device_identity(
    device: &mut TrustedDevice,
    model: Option<&str>,
    os_name: Option<&str>,
    os_version: Option<&str>,
    os_build_version: Option<&str>,
    source_version: Option<&str>,
) {
    device.model = model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    device.os_name = os_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    device.os_version = os_version
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    device.os_build_version = os_build_version
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    device.source_version = source_version
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
}

fn find_device_mut<'a>(
    registry: &'a mut TrustedDeviceRegistry,
    device_name: &str,
    device_id: Option<&str>,
    model: Option<&str>,
    os_name: Option<&str>,
    os_version: Option<&str>,
    os_build_version: Option<&str>,
    source_version: Option<&str>,
) -> Option<&'a mut TrustedDevice> {
    let device_key = device_key_for_identity(device_id, device_name)?;
    let now = now_unix_timestamp();
    let normalized_device_id = device_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);

    if let Some(index) = registry
        .devices
        .iter()
        .position(|device| device.key == device_key)
    {
        let device = &mut registry.devices[index];
        device.display_name = device_name.trim().to_string();
        device.device_id = normalized_device_id;
        device.last_seen_at = now;
        apply_device_identity(
            device,
            model,
            os_name,
            os_version,
            os_build_version,
            source_version,
        );
        return Some(device);
    }

    None
}

fn upsert_device<'a>(
    registry: &'a mut TrustedDeviceRegistry,
    device_name: &str,
    device_id: Option<&str>,
    model: Option<&str>,
    os_name: Option<&str>,
    os_version: Option<&str>,
    os_build_version: Option<&str>,
    source_version: Option<&str>,
) -> Option<&'a mut TrustedDevice> {
    let device_key = device_key_for_identity(device_id, device_name)?;
    let now = now_unix_timestamp();
    let normalized_device_id = device_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);

    if let Some(index) = registry
        .devices
        .iter()
        .position(|device| device.key == device_key)
    {
        let device = &mut registry.devices[index];
        device.display_name = device_name.trim().to_string();
        device.device_id = normalized_device_id;
        device.last_seen_at = now;
        apply_device_identity(
            device,
            model,
            os_name,
            os_version,
            os_build_version,
            source_version,
        );
        return Some(device);
    }

    registry.devices.push(TrustedDevice {
        key: device_key,
        device_id: normalized_device_id,
        display_name: device_name.trim().to_string(),
        model: model
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        os_name: os_name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        os_version: os_version
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        os_build_version: os_build_version
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        source_version: source_version
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        nickname: None,
        first_seen_at: now,
        last_seen_at: now,
        trusted_at: None,
        last_successful_connection_at: None,
        last_pairing_at: None,
        pending_pairing: false,
        is_blocked: false,
        blocked_reason: None,
        last_failure_at: None,
        last_failure_reason: None,
    });

    registry.devices.last_mut()
}

pub(crate) fn device_key_for_identity(
    device_id: Option<&str>,
    _device_name: &str,
) -> Option<String> {
    device_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
}

pub(crate) fn apply_current_device_trust(
    snapshot: &mut SessionSnapshot,
    trusted_devices: &[TrustedDevice],
) {
    snapshot.current_device_key =
        device_key_for_identity(snapshot.current_device_id.as_deref(), &snapshot.device_name);
    snapshot.current_device_nickname = None;
    snapshot.current_device_known = false;
    snapshot.current_device_trusted = false;
    snapshot.current_device_blocked = false;
    snapshot.current_device_blocked_reason = None;

    if let Some(device_key) = snapshot.current_device_key.as_ref() {
        if let Some(device) = trusted_devices
            .iter()
            .find(|device| &device.key == device_key)
        {
            snapshot.current_device_nickname = device.nickname.clone();
            snapshot.current_device_known = true;
            if snapshot.current_device_model.is_none() {
                snapshot.current_device_model = device.model.clone();
            }
            if snapshot.current_device_os_name.is_none() {
                snapshot.current_device_os_name = device.os_name.clone();
            }
            if snapshot.current_device_os_version.is_none() {
                snapshot.current_device_os_version = device.os_version.clone();
            }
            if snapshot.current_device_os_build_version.is_none() {
                snapshot.current_device_os_build_version = device.os_build_version.clone();
            }
            if snapshot.current_device_source_version.is_none() {
                snapshot.current_device_source_version = device.source_version.clone();
            }
            snapshot.current_device_trusted = is_device_trusted(device);
            snapshot.current_device_blocked = device.is_blocked;
            snapshot.current_device_blocked_reason = device.blocked_reason.clone();
        }
    }
}

pub(crate) fn get_trusted_devices(app: &AppHandle) -> CommandResult<Vec<TrustedDevice>> {
    let _registry_guard = TRUST_REGISTRY_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    sorted_devices(load_registry(app)?.devices)
}

fn sorted_devices(mut devices: Vec<TrustedDevice>) -> CommandResult<Vec<TrustedDevice>> {
    devices.sort_by(|left, right| {
        right.last_seen_at.cmp(&left.last_seen_at).then_with(|| {
            display_label(left)
                .to_ascii_lowercase()
                .cmp(&display_label(right).to_ascii_lowercase())
        })
    });
    Ok(devices)
}

pub(crate) fn note_device_connected(
    app: &AppHandle,
    device_name: &str,
    device_id: Option<&str>,
    model: Option<&str>,
    os_name: Option<&str>,
    os_version: Option<&str>,
    os_build_version: Option<&str>,
    source_version: Option<&str>,
) -> CommandResult<Vec<TrustedDevice>> {
    let _registry_guard = TRUST_REGISTRY_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let mut registry = load_registry(app)?;
    let now = now_unix_timestamp();
    if let Some(device) = find_device_mut(
        &mut registry,
        device_name,
        device_id,
        model,
        os_name,
        os_version,
        os_build_version,
        source_version,
    ) {
        device.last_successful_connection_at = Some(now);
        device.pending_pairing = false;
        device.last_failure_reason = None;
        device.last_failure_at = None;
    }
    save_registry(app, &registry)?;
    sorted_devices(registry.devices)
}

pub(crate) fn note_pairing_state(
    app: &AppHandle,
    device_name: &str,
    device_id: Option<&str>,
    model: Option<&str>,
    os_name: Option<&str>,
    os_version: Option<&str>,
    os_build_version: Option<&str>,
    source_version: Option<&str>,
    pending_pairing: bool,
    failure_message: Option<&str>,
) -> CommandResult<Vec<TrustedDevice>> {
    let _registry_guard = TRUST_REGISTRY_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let mut registry = load_registry(app)?;
    let now = now_unix_timestamp();
    if let Some(device) = find_device_mut(
        &mut registry,
        device_name,
        device_id,
        model,
        os_name,
        os_version,
        os_build_version,
        source_version,
    ) {
        device.last_pairing_at = Some(now);
        device.pending_pairing = pending_pairing;
        if let Some(message) = failure_message.filter(|value| !value.trim().is_empty()) {
            device.last_failure_at = Some(now);
            device.last_failure_reason = Some(message.trim().to_string());
        }
    }
    save_registry(app, &registry)?;
    sorted_devices(registry.devices)
}

pub(crate) fn note_device_failure(
    app: &AppHandle,
    device_name: &str,
    device_id: Option<&str>,
    model: Option<&str>,
    os_name: Option<&str>,
    os_version: Option<&str>,
    os_build_version: Option<&str>,
    source_version: Option<&str>,
    failure_message: &str,
) -> CommandResult<Vec<TrustedDevice>> {
    let _registry_guard = TRUST_REGISTRY_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let mut registry = load_registry(app)?;
    let now = now_unix_timestamp();
    if let Some(device) = find_device_mut(
        &mut registry,
        device_name,
        device_id,
        model,
        os_name,
        os_version,
        os_build_version,
        source_version,
    ) {
        device.pending_pairing = false;
        device.last_failure_at = Some(now);
        device.last_failure_reason = Some(failure_message.trim().to_string());
    }
    save_registry(app, &registry)?;
    sorted_devices(registry.devices)
}

pub(crate) fn note_known_device(
    app: &AppHandle,
    device_name: &str,
    device_id: Option<&str>,
    model: Option<&str>,
    os_name: Option<&str>,
    os_version: Option<&str>,
    os_build_version: Option<&str>,
    source_version: Option<&str>,
) -> CommandResult<Vec<TrustedDevice>> {
    let _registry_guard = TRUST_REGISTRY_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let mut registry = load_registry(app)?;
    let now = now_unix_timestamp();
    if let Some(device) = upsert_device(
        &mut registry,
        device_name,
        device_id,
        model,
        os_name,
        os_version,
        os_build_version,
        source_version,
    ) {
        device.last_successful_connection_at = Some(now);
        device.pending_pairing = false;
        device.last_failure_at = None;
        device.last_failure_reason = None;
    } else {
        return Err(String::from("there is no active iPhone to record yet"));
    }

    save_registry(app, &registry)?;
    sorted_devices(registry.devices)
}

pub(crate) fn trust_device(
    app: &AppHandle,
    device_name: &str,
    device_id: Option<&str>,
    model: Option<&str>,
    os_name: Option<&str>,
    os_version: Option<&str>,
    os_build_version: Option<&str>,
    source_version: Option<&str>,
) -> CommandResult<Vec<TrustedDevice>> {
    let _registry_guard = TRUST_REGISTRY_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let mut registry = load_registry(app)?;
    let now = now_unix_timestamp();
    migrate_legacy_trusted_identity(&mut registry, device_name, device_id);
    if let Some(device) = upsert_device(
        &mut registry,
        device_name,
        device_id,
        model,
        os_name,
        os_version,
        os_build_version,
        source_version,
    ) {
        device.trusted_at = Some(now);
        device.last_successful_connection_at = Some(now);
        device.pending_pairing = false;
        device.last_failure_at = None;
        device.last_failure_reason = None;
        device.is_blocked = false;
        device.blocked_reason = None;
    } else {
        return Err(String::from("there is no active iPhone to trust yet"));
    }

    save_registry(app, &registry)?;
    sorted_devices(registry.devices)
}

pub(crate) fn rename_trusted_device(
    app: &AppHandle,
    device_key: &str,
    nickname: Option<&str>,
) -> CommandResult<Vec<TrustedDevice>> {
    let _registry_guard = TRUST_REGISTRY_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let mut registry = load_registry(app)?;
    if let Some(device) = registry
        .devices
        .iter_mut()
        .find(|device| device.key == device_key)
    {
        device.nickname = nickname
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
    }
    save_registry(app, &registry)?;
    sorted_devices(registry.devices)
}

pub(crate) fn set_trusted_device_blocked(
    app: &AppHandle,
    device_key: &str,
    blocked: bool,
    reason: Option<&str>,
) -> CommandResult<Vec<TrustedDevice>> {
    let _registry_guard = TRUST_REGISTRY_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let mut registry = load_registry(app)?;
    if let Some(device) = registry
        .devices
        .iter_mut()
        .find(|device| device.key == device_key)
    {
        device.is_blocked = blocked;
        device.blocked_reason = if blocked {
            reason
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .or_else(|| Some(String::from("Blocked for auto-trust on this PC.")))
        } else {
            None
        };
        if blocked {
            device.pending_pairing = false;
        }
    }
    save_registry(app, &registry)?;
    sorted_devices(registry.devices)
}

pub(crate) fn forget_trusted_device(
    app: &AppHandle,
    device_key: &str,
) -> CommandResult<Vec<TrustedDevice>> {
    let _registry_guard = TRUST_REGISTRY_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let mut registry = load_registry(app)?;
    registry.devices.retain(|device| device.key != device_key);
    save_registry(app, &registry)?;
    sorted_devices(registry.devices)
}

pub(crate) fn reset_trusted_devices(app: &AppHandle) -> CommandResult<Vec<TrustedDevice>> {
    let _registry_guard = TRUST_REGISTRY_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    save_registry(app, &TrustedDeviceRegistry::default())?;
    Ok(Vec::new())
}

#[cfg(test)]
mod tests {
    use super::{device_key_for_identity, migrate_legacy_trusted_identity, TrustedDeviceRegistry};
    use crate::models::TrustedDevice;

    fn trusted_device(key: &str, display_name: &str) -> TrustedDevice {
        TrustedDevice {
            key: key.to_string(),
            device_id: Some(key.to_string()),
            display_name: display_name.to_string(),
            model: None,
            os_name: None,
            os_version: None,
            os_build_version: None,
            source_version: None,
            nickname: Some(String::from("Presenter phone")),
            first_seen_at: 1,
            last_seen_at: 2,
            trusted_at: Some(3),
            last_successful_connection_at: Some(4),
            last_pairing_at: None,
            pending_pairing: false,
            is_blocked: false,
            blocked_reason: None,
            last_failure_at: None,
            last_failure_reason: None,
        }
    }

    #[test]
    fn persistent_trust_requires_an_authenticated_device_identity() {
        assert_eq!(
            device_key_for_identity(Some("  ABCDEF  "), "Max's iPhone").as_deref(),
            Some("abcdef")
        );
        assert_eq!(device_key_for_identity(None, "Max's iPhone"), None);
        assert_eq!(device_key_for_identity(Some("  "), "Max's iPhone"), None);
    }

    #[test]
    fn explicit_approval_rekeys_one_matching_legacy_trust_record() {
        let fingerprint = "a".repeat(64);
        let mut registry = TrustedDeviceRegistry {
            devices: vec![trusted_device("aa:bb:cc:dd:ee:ff", "Max's iPhone")],
        };

        migrate_legacy_trusted_identity(&mut registry, "Max's iPhone", Some(fingerprint.as_str()));

        let device = &registry.devices[0];
        assert_eq!(device.key, fingerprint);
        assert_eq!(device.nickname.as_deref(), Some("Presenter phone"));
        assert_eq!(device.first_seen_at, 1);
        assert_eq!(device.trusted_at, Some(3));
    }

    #[test]
    fn ambiguous_legacy_records_are_not_silently_migrated() {
        let fingerprint = "b".repeat(64);
        let mut registry = TrustedDeviceRegistry {
            devices: vec![
                trusted_device("aa:bb:cc:dd:ee:ff", "iPhone"),
                trusted_device("11:22:33:44:55:66", "iPhone"),
            ],
        };

        migrate_legacy_trusted_identity(&mut registry, "iPhone", Some(fingerprint.as_str()));

        assert!(registry
            .devices
            .iter()
            .all(|device| device.key != fingerprint));
    }
}
