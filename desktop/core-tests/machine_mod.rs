//! The machine agent's pure modules, nested as in the app (`crate::machine::x`, `super::x`).
#[path = "../src-tauri/src/machine/lease.rs"]
pub mod lease;
#[path = "../src-tauri/src/machine/prompt.rs"]
pub mod prompt;
#[path = "../src-tauri/src/machine/wire.rs"]
pub mod wire;
#[path = "../src-tauri/src/machine/mcp_http.rs"]
pub mod mcp_http;
#[path = "../src-tauri/src/machine/claude.rs"]
pub mod claude;
#[path = "../src-tauri/src/machine/overlay_layout.rs"]
pub mod overlay_layout;
#[path = "../src-tauri/src/machine/browser.rs"]
pub mod browser;
