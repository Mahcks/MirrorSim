mod commands;
mod history;
mod models;
mod persistence;
mod preview_fragments;
mod remux;
mod runtime;
mod sidecar;
mod state;
mod trust;
mod updater_config;

use crate::commands::{
    abort_recording_save, append_recording_chunk, begin_recording_save, cancel_pairing,
    check_for_app_update, confirm_pairing_trust, download_app_update, export_diagnostics_report,
    finish_recording_save, forget_trusted_device, get_bonjour_status, get_connection_history,
    get_downloaded_app_update, get_pairing_snapshot, get_preview_diagnostics,
    get_preview_init_segment, get_preview_stream_descriptor, get_preview_telemetry,
    get_receiver_runtime, get_receiver_sidecar_spec, get_remux_blueprint, get_session_snapshot,
    get_trusted_devices, install_app_update, open_windows_firewall, open_windows_services,
    prepare_preview_decoder_stream, prepare_preview_media_stream, reconnect_session,
    refresh_receiver_readiness, rename_trusted_device, report_preview_client_diagnostics,
    reset_trusted_devices, save_screenshot, set_trusted_device_blocked, start_recording,
    start_session, stop_recording, stop_session, take_preview_audio_frames,
    take_preview_media_segment, take_preview_video_access_unit, take_screenshot,
    trust_current_device,
};
use crate::runtime::AppState;
use crate::updater_config::{updater_is_configured, UPDATER_PUBKEY};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_session_snapshot,
            get_preview_telemetry,
            get_preview_stream_descriptor,
            get_preview_init_segment,
            prepare_preview_decoder_stream,
            report_preview_client_diagnostics,
            prepare_preview_media_stream,
            take_preview_media_segment,
            take_preview_video_access_unit,
            take_preview_audio_frames,
            get_remux_blueprint,
            get_receiver_sidecar_spec,
            get_receiver_runtime,
            get_preview_diagnostics,
            get_bonjour_status,
            check_for_app_update,
            download_app_update,
            get_downloaded_app_update,
            get_pairing_snapshot,
            get_trusted_devices,
            get_connection_history,
            install_app_update,
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
            begin_recording_save,
            append_recording_chunk,
            finish_recording_save,
            abort_recording_save,
            start_recording,
            stop_recording,
            open_windows_services,
            open_windows_firewall,
            export_diagnostics_report
        ])
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build());

    if updater_is_configured() {
        builder = builder.plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(UPDATER_PUBKEY.trim())
                .build(),
        );
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
