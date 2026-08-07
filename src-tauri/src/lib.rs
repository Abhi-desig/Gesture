// Menu-bar host for the gesture server.
//
// This process owns no window. It starts the Node server, keeps it alive, puts
// an icon in the menu bar, and opens the page in Chrome — it does not render
// the page itself.
//
// That is a deliberate retreat from wrapping the UI in a webview, and it is
// forced by one measured fact: Tauri's WKWebView does not implement
// MediaStreamTrackProcessor. Reported by the page itself at load:
//
//     engine=tauri-webview  hasMSTP=false   -> detection pumped by
//         requestVideoFrameCallback on the main thread, which WebKit freezes
//         for any non-visible page
//     engine=browser        hasMSTP=true    -> detector runs in a Worker, fed
//         by MediaStreamTrackProcessor, unaffected by visibility
//
// So in a webview the app can only detect while a window is on screen, and in
// Chrome it detects with the window minimised. Rendering the UI here would mean
// reimplementing camera capture and inference natively to reach a place Chrome
// already occupies. The menu bar, start-at-login and server supervision are
// worth having natively; the webview was not.

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

const SERVER_HOST: &str = "127.0.0.1";
const SERVER_PORT: u16 = 4321;
const SERVER_URL: &str = "http://127.0.0.1:4321";

/// Set only by Quit. With no windows, the app would otherwise be asked to exit
/// the moment it finishes launching, so exit is refused unless this is set.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// The Node server, so it can be killed when this process exits.
///
/// Without this the server outlives the app and holds port 4321, and the next
/// launch silently attaches to an orphan running whatever config.json said an
/// hour ago.
struct ServerProcess(Mutex<Option<Child>>);

/// Is something already listening on the server port?
fn server_is_up() -> bool {
    TcpStream::connect_timeout(
        &format!("{SERVER_HOST}:{SERVER_PORT}").parse().unwrap(),
        Duration::from_millis(200),
    )
    .is_ok()
}

/// Locate the project directory holding server/index.js.
///
/// Checked in order rather than assumed, because the answer differs between
/// `tauri dev` (the repo, some directories up from the binary) and a bundled
/// .app (a resource directory inside the bundle). GESTURE_ROOT overrides both.
///
/// NOTE: bundling the Node runtime and node_modules into the .app is not solved
/// here — a release build still expects a working `node` on PATH and the
/// project directory present.
fn find_project_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Ok(root) = std::env::var("GESTURE_ROOT") {
        let path = PathBuf::from(root);
        if path.join("server/index.js").is_file() {
            return Some(path);
        }
    }

    if let Ok(resources) = app.path().resource_dir() {
        if resources.join("server/index.js").is_file() {
            return Some(resources);
        }
    }

    // Deep enough to escape a dev bundle, whose exe sits eight directories
    // inside the repo: src-tauri/target/release/bundle/macos/Gesture.app/
    // Contents/MacOS/gesture.
    let exe = std::env::current_exe().ok()?;
    let mut dir = exe.parent()?.to_path_buf();
    for _ in 0..10 {
        if dir.join("server/index.js").is_file() {
            return Some(dir);
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

/// Find a Node binary the way a *GUI* process has to.
///
/// An app launched from Finder or at login inherits launchd's PATH —
/// /usr/bin:/bin:/usr/sbin:/sbin — which contains none of the places people
/// actually install Node. `Command::new("node")` therefore works from a
/// terminal and silently fails from a double-click. GESTURE_NODE overrides.
fn find_node() -> Option<PathBuf> {
    if let Ok(node) = std::env::var("GESTURE_NODE") {
        let path = PathBuf::from(node);
        if path.is_file() {
            return Some(path);
        }
    }

    let candidates = [
        "/opt/homebrew/bin/node", // Homebrew on Apple silicon
        "/usr/local/bin/node",    // Homebrew on Intel, and the pkg installer
        "/usr/bin/node",
    ];
    for candidate in candidates {
        let path = PathBuf::from(candidate);
        if path.is_file() {
            return Some(path);
        }
    }

    which_on_path("node")
}

fn which_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// Start the Node server, unless one is already running.
///
/// Attaching to an existing server is intentional: it makes `npm start` in a
/// terminal and this app interchangeable during development, and it means a
/// second launch cannot end up with two processes fighting over the port.
fn start_server(app: &tauri::AppHandle) -> Option<Child> {
    if server_is_up() {
        println!("gesture: attaching to the server already on {SERVER_URL}");
        return None;
    }

    let root = match find_project_root(app) {
        Some(root) => root,
        None => {
            eprintln!("gesture: could not find server/index.js — set GESTURE_ROOT to the project directory");
            return None;
        }
    };

    let node = match find_node() {
        Some(node) => node,
        None => {
            eprintln!("gesture: no node binary found — set GESTURE_NODE to its path");
            return None;
        }
    };

    println!(
        "gesture: starting {} server/index.js from {}",
        node.display(),
        root.display()
    );
    // The child watches this pid and exits when it dies. The RunEvent::Exit
    // cleanup below covers a graceful quit, but not a SIGKILL — which is how an
    // orphan node ended up holding port 4321 with its TCC permissions
    // attributed to a dead app, failing every osascript call.
    match Command::new(&node)
        .arg("server/index.js")
        .env("GESTURE_PARENT_PID", std::process::id().to_string())
        .current_dir(&root)
        .spawn()
    {
        Ok(child) => Some(child),
        Err(err) => {
            eprintln!("gesture: could not start {} ({err})", node.display());
            None
        }
    }
}

fn wait_for_server(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if server_is_up() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// Open the page in Chrome, in an app-style window with no tab strip or
/// address bar.
///
/// Chrome specifically, not the default browser: the whole reason the UI lives
/// outside this process is that Chrome implements MediaStreamTrackProcessor and
/// WebKit does not. Handing the page to Safari would reintroduce exactly the
/// limitation this design exists to avoid, so Safari is not a silent fallback —
/// if Chrome is missing we say so and let the default browser have it, where at
/// least the page still works while visible.
fn open_ui() {
    let chrome = Command::new("open")
        .args(["-na", "Google Chrome", "--args", &format!("--app={SERVER_URL}")])
        .status();

    match chrome {
        Ok(status) if status.success() => {}
        _ => {
            eprintln!(
                "gesture: could not open Google Chrome — falling back to the default browser. \
                 Note that detection only continues while the window is visible outside Chrome."
            );
            let _ = Command::new("open").arg(SERVER_URL).spawn();
        }
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // LaunchAgent rather than a login item: it survives OS upgrades and can
        // be inspected and removed as a plain file, which a login item cannot.
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle().clone();
            *app.state::<ServerProcess>().0.lock().unwrap() = start_server(&handle);

            // ---------------------------------------------------------- tray
            let open = MenuItem::with_id(app, "open", "Open Gesture", true, None::<&str>)?;

            // Reflects the real state rather than a stored preference, so the
            // tick is still right if the LaunchAgent was removed by hand.
            let launches_at_login = app.autolaunch().is_enabled().unwrap_or(false);
            let autostart = CheckMenuItem::with_id(
                app,
                "autostart",
                "Start at Login",
                true,
                launches_at_login,
                None::<&str>,
            )?;

            let quit = MenuItem::with_id(app, "quit", "Quit Gesture", true, None::<&str>)?;
            let first_separator = PredefinedMenuItem::separator(app)?;
            let second_separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[
                    &open,
                    &first_separator,
                    &autostart,
                    &second_separator,
                    &quit,
                ],
            )?;

            // The handler owns a reference so it can correct the tick itself:
            // macOS does not toggle a check item for you, and a tick that
            // disagrees with the LaunchAgent on disk is worse than no tick.
            let autostart_item = autostart.clone();

            // A dedicated monochrome icon, not the app icon. macOS template
            // images are recoloured from their alpha channel alone, so the real
            // logo — which has an opaque rounded-square background — would mask
            // to a solid blob in the menu bar.
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;

            TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("Gesture")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => open_ui(),
                    "autostart" => {
                        let launcher = app.autolaunch();
                        let result = if launcher.is_enabled().unwrap_or(false) {
                            launcher.disable()
                        } else {
                            launcher.enable()
                        };
                        if let Err(err) = result {
                            eprintln!("gesture: could not change the login item ({err})");
                        }
                        let _ = autostart_item
                            .set_checked(launcher.is_enabled().unwrap_or(false));
                    }
                    "quit" => {
                        QUITTING.store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // Open the UI once the server can actually answer, so the browser
            // does not land on a connection error and need a manual reload.
            std::thread::spawn(move || {
                if wait_for_server(Duration::from_secs(15)) {
                    println!("gesture: server is up, opening {SERVER_URL}");
                    open_ui();
                } else {
                    eprintln!("gesture: the server never came up on {SERVER_URL}");
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Gesture app")
        .run(|app, event| match event {
            // With no windows there is nothing keeping the app alive, so it is
            // asked to exit as soon as it has launched. Refuse, except when the
            // request came from Quit.
            RunEvent::ExitRequested { api, .. } => {
                if !QUITTING.load(Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
            // Kill the server on the way out — an orphan holding port 4321 is a
            // confusing thing to debug the next time the app starts.
            RunEvent::Exit => {
                if let Some(mut child) = app.state::<ServerProcess>().0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
            _ => {}
        });
}
