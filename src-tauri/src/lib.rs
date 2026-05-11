mod commands;
mod history;
mod models;
mod preview_fragments;
mod remux;
mod runtime;
mod sidecar;
mod state;
mod trust;

use crate::commands::{
    cancel_pairing, confirm_pairing_trust, forget_trusted_device, get_bonjour_status,
    get_connection_history,
    get_pairing_snapshot, get_preview_diagnostics, get_preview_init_segment,
    get_preview_stream_descriptor, get_preview_telemetry, get_receiver_runtime,
    get_receiver_sidecar_spec, get_remux_blueprint, get_session_snapshot,
    get_trusted_devices, open_windows_firewall, open_windows_services, reconnect_session,
    refresh_receiver_readiness, rename_trusted_device, reset_trusted_devices,
    save_recording, save_screenshot, set_trusted_device_blocked, start_recording,
    start_session, stop_recording, stop_session,
    take_preview_media_segment, take_screenshot, trust_current_device,
    export_diagnostics_report,
};
use crate::runtime::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_session_snapshot,
            get_preview_telemetry,
            get_preview_stream_descriptor,
            get_preview_init_segment,
            take_preview_media_segment,
            get_remux_blueprint,
            get_receiver_sidecar_spec,
            get_receiver_runtime,
            get_preview_diagnostics,
            get_bonjour_status,
            get_pairing_snapshot,
            get_trusted_devices,
            get_connection_history,
            start_session,
            reconnect_session,
            refresh_receiver_readiness,
            stop_session,
            confirm_pairing_trust,
            cancel_pairing,
            trust_current_device,
            forget_trusted_device,
            rename_trusted_device,
            set_trusted_device_blocked,
            reset_trusted_devices,
            take_screenshot,
            save_screenshot,
            save_recording,
            start_recording,
            stop_recording,
            open_windows_services,
            open_windows_firewall,
            export_diagnostics_report
        ])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
