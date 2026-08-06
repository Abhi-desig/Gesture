// Tauri shell around the existing app.
//
// Deliberately thin. The recogniser is still the JavaScript in public/, and the
// key pressing is still the Node server in server/ — this process starts that
// server, points a webview at it, and adds the three things a browser tab
// cannot do: live in the menu bar, start at login, and keep running with no
// window on screen.
//
// The window loads http://127.0.0.1:4321 rather than bundled assets. That keeps
// the page same-origin with the server it talks to, so nothing in public/ has to
// change, and it keeps the page on an http://127.0.0.1 origin — which macOS
// treats as a secure context, the precondition for getUserMedia.

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

const SERVER_HOST: &str = "127.0.0.1";
const SERVER_PORT: u16 = 4321;
const SERVER_URL: &str = "http://127.0.0.1:4321";

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
/// `tauri dev` (the repo, two directories up from the binary) and a bundled
/// .app (a resource directory inside the bundle). GESTURE_ROOT overrides both.
///
/// NOTE: bundling the Node runtime and node_modules into the .app is not solved
/// here — a release build still expects a working `node` on PATH and the
/// project directory present. That is the next phase's problem, not this one's.
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
/// terminal and silently fails from a double-click, which is the worst kind of
/// works-on-my-machine. GESTURE_NODE overrides the search.
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

    // Fall back to PATH for the terminal-launched case, plus nvm-style setups
    // where the shell profile is the only thing that knows the location.
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
    match Command::new(&node)
        .arg("server/index.js")
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

/// Block until the server answers, so the webview is not pointed at a dead port.
///
/// The window starts hidden and is only shown after this returns, because a
/// webview that loads a connection error shows it until something reloads it —
/// and the first thing a new user would see is a browser error page.
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

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
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
            let show = MenuItem::with_id(app, "show", "Show Gesture", true, None::<&str>)?;
            let browser = MenuItem::with_id(
                app,
                "browser",
                "Open in Browser…",
                true,
                None::<&str>,
            )?;
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
                    &show,
                    &browser,
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

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .tooltip("Gesture")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    // An escape hatch that matters more than it looks: if the
                    // webview cannot reach the camera, the same page still works
                    // in a real browser, and the rest of the app is unaffected.
                    "browser" => {
                        let _ = Command::new("open").arg(SERVER_URL).spawn();
                    }
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
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // ------------------------------------------------- window & server
            if let Some(window) = app.get_webview_window("main") {
                // Closing the window puts the app in the menu bar rather than
                // quitting it. Detection is supposed to keep running while you
                // work; quitting on close would make that impossible to express.
                let hide_target = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = hide_target.hide();
                    }
                });
            }

            std::thread::spawn(move || {
                if wait_for_server(Duration::from_secs(15)) {
                    if let Some(window) = handle.get_webview_window("main") {
                        // Reload: the webview was pointed at the port before the
                        // server was listening, so it is showing a failure page.
                        let _ = window.eval("location.replace(location.href)");
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                } else {
                    eprintln!("gesture: the server never came up on {SERVER_URL}");
                    show_main_window(&handle);
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Gesture app")
        .run(|app, event| {
            // Kill the server on the way out, including on a SIGINT from a
            // terminal — an orphan holding port 4321 is a confusing thing to
            // debug the next time the app starts.
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.state::<ServerProcess>().0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
