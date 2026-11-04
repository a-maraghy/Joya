//! See Cargo.toml: the app's pure modules, by path.
#[macro_use]
#[path = "../src-tauri/src/log.rs"]
pub mod log;
#[path = "../src-tauri/src/hit.rs"]
pub mod hit;
#[path = "../src-tauri/src/blur.rs"]
pub mod blur;
#[path = "../src-tauri/src/layout.rs"]
pub mod layout;
#[path = "../src-tauri/src/companion.rs"]
pub mod companion;
#[path = "../src-tauri/src/presence.rs"]
pub mod presence;
#[path = "../src-tauri/src/platform.rs"]
pub mod platform;
#[path = "../src-tauri/src/policy.rs"]
pub mod policy;
#[path = "../src-tauri/src/settings.rs"]
pub mod settings;
#[path = "../src-tauri/src/signin.rs"]
pub mod signin;
#[path = "../src-tauri/src/trayicon.rs"]
pub mod trayicon;
#[path = "../src-tauri/src/site.rs"]
pub mod site;
// Laptop control ("This computer"): the machine agent's pure parts, nested as in the app.
#[path = "machine_mod.rs"]
pub mod machine;
// Laptop control: the hands' pure parts (risk rules, coordinate / key mapping, document files, the
// Office / PDF tools' paths, file engine and PDF handling). Nested as in the app, so `crate::hands::x` works.
#[path = "../src-tauri/src/hands/mod.rs"]
pub mod hands;
