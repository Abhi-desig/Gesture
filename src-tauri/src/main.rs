// Prevents an extra console window on Windows in release. Harmless on macOS,
// and kept so this file does not have to change if the app is ever built there.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    gesture_lib::run()
}
