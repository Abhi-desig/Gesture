fn main() {
    // The orb's island is SwiftUI (island/), compiled here and linked into the
    // app. swift-rs is already in the build through Tauri; its linker finds
    // the Swift runtime.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        swift_rs::SwiftLinker::new("13.0").with_package("Island", "island").link();
    }

    // The orb's page is loaded from the local server, which makes it a remote
    // page to Tauri, and a remote page may call only the commands listed here
    // and granted in capabilities/orb.json. Without this list every call from
    // the orb is refused, silently.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["orb_view", "orb_menu", "open_settings", "hide_settings"]),
    ))
    .expect("failed to run the Tauri build script")
}
