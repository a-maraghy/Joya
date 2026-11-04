fn main() {
    // The app's own commands, as permissions: capabilities/remote.json grants the page only the
    // ones it needs; the Settings window (local) gets the rest.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
        "get_state",
        "set_hit_regions",
        "set_blur_rects",
        "set_status",
        "needs_you",
        "hide_peek",
        "start_drag",
        "tool",
        "set_glance",
        // Companion mode: the page's word (a click on the bot opens its Command Center; it dozes / wakes).
        "companion",
        // Eye contact: the page says it holds the camera (the tray shows it), and may switch camera presence off.
        "presence_status",
        "presence_off",
        "open_full_cc",
        "go_site",
        "webauthn_ceremony",
        "page_ready",
        "browser_signin",
        "settings_get",
        "settings_set",
        "settings_close",
        "settings_check_update",
        // Laptop control (machine/): the Settings window's "This computer" (the control pill is native since 0.1.7).
        "machine_status",
        "machine_link",
        "machine_unlink",
        "machine_claude_check",
    ])))
    .expect("failed to run tauri-build");
}
