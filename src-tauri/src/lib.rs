// Desktop host for Gesture: the orb under the camera.
//
// Gesture lives in two windows, neither of which looks like an app:
//
//   - the orb: a small see-through panel at the top of the built-in screen,
//     right under the camera: Jelly, the mascot, in a floating island of
//     macOS's Liquid Glass, drawn from public/orb.html over glass this process
//     puts behind it. It greets you, glows when the camera is on, and says in
//     words what a gesture did or what went wrong. Clicking it turns the
//     camera on and off.
//   - the engine: the full page, running in a Chrome window of its own that is
//     kept hidden. It runs the camera and the detection, and it is also the
//     Settings window, shown from the orb's right-click menu.
//
// This process starts the Node server both talk to, puts up the orb, and keeps
// the engine running. It renders the orb in its own webview, but not the
// engine, and that split is forced by one measured fact: Tauri's WKWebView
// does not implement MediaStreamTrackProcessor. Reported by the page itself at
// load:
//
//     engine=tauri-webview  hasMSTP=false   -> detection pumped by
//         requestVideoFrameCallback on the main thread, which WebKit freezes
//         for any non-visible page
//     engine=browser        hasMSTP=true    -> detector runs in a Worker, fed
//         by MediaStreamTrackProcessor, unaffected by visibility
//
// So detection has to live in Chrome to keep running out of sight. The orb has
// no camera and needs none of that: a webview is fine for drawing it.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::{LogicalPosition, LogicalSize, Manager, RunEvent, WebviewUrl, WebviewWindow};
use tauri_nspanel::{tauri_panel, CollectionBehavior, PanelBuilder, PanelLevel, StyleMask};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

const SERVER_HOST: &str = "127.0.0.1";
const SERVER_PORT: u16 = 4321;
const SERVER_URL: &str = "http://127.0.0.1:4321";

/// Set only by Quit. With the orb being a panel rather than a normal window,
/// the app would otherwise be asked to exit the moment it finishes launching,
/// so exit is refused unless this is set.
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
    if let Some(mut dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)) {
        for _ in 0..10 {
            if dir.join("server/index.js").is_file() {
                return Some(dir);
            }
            let Some(parent) = dir.parent() else { break };
            dir = parent.to_path_buf();
        }
    }

    // An app copied to /Applications has neither: use the project it was
    // built from, which on the Mac that built it is still there.
    let built_from = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
    built_from.join("server/index.js").is_file().then(|| built_from.to_path_buf())
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

/// GET a path from the server and return the body. Plain HTTP/1.0 over a
/// socket, like `server_is_up`: a tiny loopback request does not justify an
/// HTTP client.
fn http_get(path: &str) -> Option<String> {
    let addr = format!("{SERVER_HOST}:{SERVER_PORT}").parse().ok()?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(200)).ok()?;
    stream.set_read_timeout(Some(Duration::from_millis(500))).ok()?;
    stream
        .write_all(format!("GET {path} HTTP/1.0\r\nHost: {SERVER_HOST}\r\n\r\n").as_bytes())
        .ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    if !response.starts_with("HTTP/1.1 200") && !response.starts_with("HTTP/1.0 200") {
        return None;
    }
    Some(response.split("\r\n\r\n").nth(1)?.to_string())
}

/// POST a JSON body to the server; true when it answered 200.
fn http_post(path: &str, json: &str) -> bool {
    let Ok(addr) = format!("{SERVER_HOST}:{SERVER_PORT}").parse() else { return false };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(200)) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let request = format!(
        "POST {path} HTTP/1.0\r\nHost: {SERVER_HOST}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{json}",
        json.len()
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

/// Tell the orb the camera page can't run, in words, as the page itself would.
fn engine_failed(why: &str) {
    let body = serde_json::json!({ "state": "failed", "error": why }).to_string();
    http_post("/camera/state", &body);
}

/// How many engine pages are connected, from GET /orb.
fn engines_connected() -> Option<u64> {
    let json: serde_json::Value = serde_json::from_str(&http_get("/orb")?).ok()?;
    json["engines"].as_u64()
}

// ------------------------------------------------------------------ engine
//
// The page that runs the camera, in a Chrome of its own: its own profile, so it
// never touches your browsing, and its own process, so it can be hidden and
// shown without touching your Chrome windows.
//
// It is launched through `open`, not spawned as a child. A child process's
// camera access is charged by macOS to the app that spawned it — this one, or
// the terminal running `tauri dev` — and asked for in its name. Through
// LaunchServices, Chrome asks as Chrome, which already has the camera. The
// cost is that it is not our child, so it is found again by its profile
// directory in the process list.

/// The engine's process, once found. 0 when there is none.
static ENGINE_PID: AtomicI32 = AtomicI32::new(0);

/// Settings is the engine's window, shown. While it is, nothing hides it.
static SETTINGS_OPEN: AtomicBool = AtomicBool::new(false);

/// How often the engine is checked on.
const ENGINE_POLL: Duration = Duration::from_secs(1);
/// After a launch, the window is kept hidden for this long: Chrome opens and
/// activates its window on its own schedule, so one hide() is not enough.
const ENGINE_HIDE_FOR: Duration = Duration::from_secs(10);
/// A launch gets this long before a missing engine counts as a failure.
const ENGINE_BOOT: Duration = Duration::from_secs(20);
/// Chrome running with no engine page for this long — its window was closed —
/// and it is quit and launched again, hidden.
const ENGINE_QUIET: Duration = Duration::from_secs(5);
/// The shortest time between two launches, so a Chrome that won't start is not
/// launched in a tight loop.
const ENGINE_RELAUNCH_GAP: Duration = Duration::from_secs(10);

/// Where Chrome is. GESTURE_CHROME overrides, as a path to the .app.
fn find_chrome_app() -> Option<PathBuf> {
    if let Ok(app) = std::env::var("GESTURE_CHROME") {
        let path = PathBuf::from(app);
        if path.is_dir() {
            return Some(path);
        }
    }
    let mut candidates = vec![PathBuf::from("/Applications/Google Chrome.app")];
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join("Applications/Google Chrome.app"));
    }
    candidates.into_iter().find(|path| path.is_dir())
}

/// The engine's Chrome profile: separate from yours, so the camera grant, the
/// window and the page's settings are Gesture's alone.
fn engine_profile() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Application Support/Gesture/Engine"))
}

/// Chrome's command line for the engine.
///
/// The three background switches keep the page's own thread at full speed
/// while its window is hidden. Detection itself runs in a Worker and doesn't
/// need them; the page's mood updates, heartbeats and gesture requests do.
fn engine_args(profile: &Path) -> Vec<String> {
    vec![
        format!("--user-data-dir={}", profile.display()),
        format!("--app={SERVER_URL}/?engine=1"),
        "--no-first-run".into(),
        "--no-default-browser-check".into(),
        "--hide-crash-restore-bubble".into(),
        "--disable-background-timer-throttling".into(),
        "--disable-backgrounding-occluded-windows".into(),
        "--disable-renderer-backgrounding".into(),
        "--window-size=1100,800".into(),
        // The hidden page is never clicked, which Chrome otherwise requires
        // before any sound: without this the cues never play.
        "--autoplay-policy=no-user-gesture-required".into(),
    ]
}

/// The engine's browser process in `ps -axww -o pid=,command=` output.
///
/// Matched by its profile directory, which no other Chrome uses. Chrome's
/// helper processes carry it too, but always with a `--type=`; the browser
/// process is the one without.
fn engine_pid_in(ps: &str, profile: &Path) -> Option<i32> {
    let marker = format!("--user-data-dir={}", profile.display());
    ps.lines().find_map(|line| {
        let line = line.trim_start();
        let (pid, command) = line.split_once(' ')?;
        if command.contains(&marker) && !command.contains("--type=") {
            pid.parse().ok()
        } else {
            None
        }
    })
}

fn find_engine(profile: &Path) -> Option<i32> {
    let output = Command::new("ps").args(["-axww", "-o", "pid=,command="]).output().ok()?;
    engine_pid_in(&String::from_utf8_lossy(&output.stdout), profile)
}

/// Start the engine in the background and hidden (`open -g -j`), in a new
/// instance (`-n`) even when your own Chrome is already running.
fn launch_engine(chrome: &Path, profile: &Path) -> bool {
    let status = Command::new("open")
        .args(["-n", "-g", "-j", "-a"])
        .arg(chrome)
        .arg("--args")
        .args(engine_args(profile))
        .status();
    match status {
        Ok(status) if status.success() => true,
        _ => {
            eprintln!("gesture: could not launch {} for the camera page", chrome.display());
            engine_failed("Google Chrome wouldn't open for the camera page");
            false
        }
    }
}

#[cfg(target_os = "macos")]
fn with_engine(pid: i32, act: impl FnOnce(&objc2_app_kit::NSRunningApplication)) {
    if pid <= 0 {
        return;
    }
    if let Some(app) = objc2_app_kit::NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
        act(&app);
    }
}

#[cfg(target_os = "macos")]
fn hide_engine(pid: i32) {
    with_engine(pid, |app| {
        if !app.isHidden() {
            app.hide();
        }
    });
}

#[cfg(target_os = "macos")]
fn show_engine(pid: i32) {
    with_engine(pid, |app| {
        app.unhide();
        app.activateWithOptions(objc2_app_kit::NSApplicationActivationOptions::ActivateAllWindows);
    });
}

/// Ask Chrome to quit, the polite way: a killed Chrome offers to restore its
/// pages on the next launch.
#[cfg(target_os = "macos")]
fn quit_engine(pid: i32) {
    with_engine(pid, |app| {
        app.terminate();
    });
}

// Gesture is a macOS app; these keep the crate building elsewhere.
#[cfg(not(target_os = "macos"))]
fn hide_engine(_pid: i32) {}
#[cfg(not(target_os = "macos"))]
fn show_engine(_pid: i32) {}
#[cfg(not(target_os = "macos"))]
fn quit_engine(_pid: i32) {}

/// Keep exactly one engine running, hidden unless Settings is open.
///
/// An engine left over from a previous run — the app was force-quit, say — is
/// adopted rather than doubled: it reconnects to the new server by itself.
fn supervise_engine() {
    std::thread::spawn(|| {
        let (Some(chrome), Some(profile)) = (find_chrome_app(), engine_profile()) else {
            eprintln!("gesture: Google Chrome not found — the camera page can't run. Set GESTURE_CHROME to its .app");
            engine_failed("Gesture needs Google Chrome for the camera");
            return;
        };
        let mut launched_at: Option<Instant> = None;
        let mut quiet_since: Option<Instant> = None;

        while !QUITTING.load(Ordering::SeqCst) {
            // Once its pid is known, a signal-0 check says whether it lives:
            // a syscall, where `ps` is a process spawned every second.
            let known = ENGINE_PID.load(Ordering::SeqCst);
            let alive = known > 0 && unsafe { libc::kill(known, 0) } == 0;
            match if alive { Some(known) } else { find_engine(&profile) } {
                None => {
                    ENGINE_PID.store(0, Ordering::SeqCst);
                    quiet_since = None;
                    let due = launched_at.map_or(true, |at| at.elapsed() >= ENGINE_RELAUNCH_GAP);
                    if due && !QUITTING.load(Ordering::SeqCst) {
                        println!("gesture: launching the camera page in {}", chrome.display());
                        SETTINGS_OPEN.store(false, Ordering::SeqCst);
                        launched_at = Some(Instant::now());
                        launch_engine(&chrome, &profile);
                    }
                }
                Some(pid) => {
                    ENGINE_PID.store(pid, Ordering::SeqCst);
                    let fresh = launched_at.is_some_and(|at| at.elapsed() < ENGINE_HIDE_FOR);
                    if fresh && !SETTINGS_OPEN.load(Ordering::SeqCst) {
                        hide_engine(pid);
                    }

                    let booting = launched_at.is_some_and(|at| at.elapsed() < ENGINE_BOOT);
                    if engines_connected() == Some(0) && !booting {
                        let since = *quiet_since.get_or_insert_with(Instant::now);
                        if since.elapsed() >= ENGINE_QUIET {
                            println!("gesture: the camera page is gone; restarting its Chrome");
                            quit_engine(pid);
                            quiet_since = None;
                        }
                    } else {
                        quiet_since = None;
                    }
                }
            }
            std::thread::sleep(ENGINE_POLL);
        }
    });
}

// ------------------------------------------------------------------ orb
//
// A panel, not a window: it floats over every app and every desktop, and
// clicking it never takes focus from the document you're typing in.

tauri_panel! {
    panel!(OrbPanel {
        config: {
            can_become_key_window: false,
            can_become_main_window: false,
            is_floating_panel: true
        }
    })
}

/// A display, in points, with the top-left of the main display at 0,0 and y
/// growing downward: CoreGraphics' global space, which is also what Tauri's
/// logical positions use on macOS.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Screen {
    builtin: bool,
    main: bool,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// The orb's panel, in points: room for the notch at its widest (376 × 32 pt,
/// in island/Sources/Island/Island.swift) and for the glass's shadow. Made
/// once at this size and never resized: the notch opens and closes inside it,
/// and the panel lets clicks through everywhere else.
const ORB_PANEL: (f64, f64) = (400.0, 48.0);

/// The app, for the island's clicks, which arrive from Swift with nothing else.
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Where the orb's top-left goes for a panel this wide: centred at the very
/// top of the built-in screen, which is where the camera is. With the lid
/// closed on a desk there is no camera above any screen, so it goes on the
/// main one.
fn orb_position(screens: &[Screen], width: f64) -> Option<(f64, f64)> {
    let screen = screens
        .iter()
        .find(|s| s.builtin)
        .or_else(|| screens.iter().find(|s| s.main))
        .or_else(|| screens.first())?;
    Some((screen.x + ((screen.width - width) / 2.0).round(), screen.y))
}

#[cfg(target_os = "macos")]
fn screens() -> Vec<Screen> {
    #[repr(C)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
        fn CGDisplayIsBuiltin(display: u32) -> u32;
        fn CGDisplayBounds(display: u32) -> CGRect;
    }

    let mut ids = [0u32; 16];
    let mut count = 0u32;
    // SAFETY: the buffer holds `ids.len()` displays and CoreGraphics writes no
    // more than that; the other calls take a display id and return plain values.
    unsafe {
        if CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut count) != 0 {
            return Vec::new();
        }
        let main = CGMainDisplayID();
        ids[..count as usize]
            .iter()
            .map(|&id| {
                let bounds = CGDisplayBounds(id);
                Screen {
                    builtin: CGDisplayIsBuiltin(id) != 0,
                    main: id == main,
                    x: bounds.origin.x,
                    y: bounds.origin.y,
                    width: bounds.size.width,
                    height: bounds.size.height,
                }
            })
            .collect()
    }
}

#[cfg(not(target_os = "macos"))]
fn screens() -> Vec<Screen> {
    Vec::new()
}

// Keeping the orb still while you swipe between desktops.
//
// A window that joins all Spaces is still drawn into each desktop's picture,
// and the swipe slides those pictures, the orb with them; it jumps back once
// the swipe ends. Notch apps all fix it the same way: the window goes on a
// private "space" of WindowServer's own, above every desktop, which a swipe
// doesn't move (boring.notch: CGSSpace at level 2147483647, flag 1). It must
// also be taken off the desktop it was shown on, or that copy still slides
// (the Vitals fix, with SLSSpaceAddWindowsAndRemoveFromSpaces, mask 0x7).
//
// These are private SkyLight functions: no documentation and no promise. They
// are looked up at run time, so if an update removes one the orb still shows,
// it just slides again, and the terminal says so. Checked present on macOS
// 26.6.
#[cfg(target_os = "macos")]
mod pinned {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    type Connection = i32;
    type SpaceId = u64;

    #[repr(C)]
    struct Opaque {
        _private: [u8; 0],
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        static kCFTypeArrayCallBacks: Opaque;
        fn CFArrayCreate(allocator: *const c_void, values: *const *const c_void, count: isize, callbacks: *const Opaque) -> *const c_void;
        fn CFNumberCreate(allocator: *const c_void, number_type: isize, value: *const c_void) -> *const c_void;
        fn CFRelease(object: *const c_void);
    }
    const CF_NUMBER_SINT64: isize = 4;

    /// The orb's space, and the calls that use it.
    struct Space {
        connection: Connection,
        id: SpaceId,
        claim: unsafe extern "C" fn(Connection, SpaceId, *const c_void, i32) -> i32,
        hide: unsafe extern "C" fn(Connection, *const c_void) -> i32,
        destroy: unsafe extern "C" fn(Connection, SpaceId) -> i32,
    }

    static SPACE: OnceLock<Option<Space>> = OnceLock::new();

    /// The highest level a space can have: above every desktop and full-screen app.
    const TOP: i32 = 2147483647;
    /// Current, other and user spaces: the window leaves every desktop.
    const EVERY_DESKTOP: i32 = 0x7;

    /// A CFArray of numbers. The caller releases it.
    unsafe fn numbers(values: &[i64]) -> *const c_void {
        let items: Vec<*const c_void> = values
            .iter()
            .map(|v| CFNumberCreate(std::ptr::null(), CF_NUMBER_SINT64, v as *const i64 as *const c_void))
            .collect();
        let array = CFArrayCreate(std::ptr::null(), items.as_ptr(), items.len() as isize, &kCFTypeArrayCallBacks);
        for item in items {
            CFRelease(item);
        }
        array
    }

    unsafe fn symbol<T>(library: *mut c_void, name: &std::ffi::CStr) -> Option<T> {
        let found = libc::dlsym(library, name.as_ptr());
        // SAFETY (caller): T is the function pointer type of that symbol.
        (!found.is_null()).then(|| std::mem::transmute_copy::<*mut c_void, T>(&found))
    }

    fn space() -> Option<&'static Space> {
        SPACE
            .get_or_init(|| unsafe {
                let sky = libc::dlopen(c"/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight".as_ptr(), libc::RTLD_LAZY);
                if sky.is_null() {
                    return None;
                }
                let main: unsafe extern "C" fn() -> Connection = symbol(sky, c"SLSMainConnectionID")?;
                let create: unsafe extern "C" fn(Connection, usize, *const c_void) -> SpaceId = symbol(sky, c"SLSSpaceCreate")?;
                let set_level: unsafe extern "C" fn(Connection, SpaceId, i32) -> i32 = symbol(sky, c"SLSSpaceSetAbsoluteLevel")?;
                let show: unsafe extern "C" fn(Connection, *const c_void) -> i32 = symbol(sky, c"SLSShowSpaces")?;
                let space = Space {
                    connection: main(),
                    id: 0,
                    claim: symbol(sky, c"SLSSpaceAddWindowsAndRemoveFromSpaces")?,
                    hide: symbol(sky, c"SLSHideSpaces")?,
                    destroy: symbol(sky, c"SLSSpaceDestroy")?,
                };
                // Flag 1: any other value and Finder starts drawing desktop
                // icons into the space (boring.notch's note).
                let id = create(space.connection, 1, std::ptr::null());
                if id == 0 {
                    return None;
                }
                set_level(space.connection, id, TOP);
                let spaces = numbers(&[id as i64]);
                show(space.connection, spaces);
                CFRelease(spaces);
                Some(Space { id, ..space })
            })
            .as_ref()
    }

    /// Move a window onto the orb's space and off every desktop. False when
    /// SkyLight didn't offer the calls.
    pub fn pin(window_number: isize) -> bool {
        let Some(space) = space() else { return false };
        unsafe {
            let windows = numbers(&[window_number as i64]);
            let error = (space.claim)(space.connection, space.id, windows, EVERY_DESKTOP);
            CFRelease(windows);
            error == 0
        }
    }

    /// Take the space down. WindowServer would on exit anyway; this is tidier.
    pub fn release() {
        if let Some(Some(space)) = SPACE.get() {
            unsafe {
                let spaces = numbers(&[space.id as i64]);
                (space.hide)(space.connection, spaces);
                CFRelease(spaces);
                (space.destroy)(space.connection, space.id);
            }
        }
    }
}

/// Keep the orb still across desktop swipes, and say whether that worked.
fn pin_orb(panel: &tauri_nspanel::PanelHandle<tauri::Wry>) {
    // An escape hatch if a macOS update makes the private space misbehave.
    if std::env::var_os("GESTURE_NO_PIN").is_some() {
        println!("gesture: GESTURE_NO_PIN is set; the orb will slide with desktop swipes");
        return;
    }
    #[cfg(target_os = "macos")]
    {
        if !pinned::pin(panel.as_panel().windowNumber()) {
            eprintln!("gesture: couldn't pin the orb above the desktops; it will slide when you switch");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = panel;
}

// The island: SwiftUI, in island/ (Island.swift), compiled and linked by
// build.rs. It draws the Liquid Glass, the words and the light, and holds the
// orb's web page as Jelly; the page decides what to show and says so with the
// orb_view command. Native, so that the glass, the text and Jelly move in one
// animation, on springs, in a panel that is never resized.
#[cfg(target_os = "macos")]
mod island {
    use std::ffi::{c_char, c_void, CString};

    extern "C" {
        fn island_install(panel: *mut c_void, webview: *mut c_void, on_click: extern "C" fn(), on_menu: extern "C" fn()) -> bool;
        fn island_show(pill: bool, tone: *const c_char, words: *const c_char, label: *const c_char);
    }

    /// Put the island into the orb's panel, around its web view. On the main thread.
    pub fn install(panel: *mut c_void, webview: *mut c_void, on_click: extern "C" fn(), on_menu: extern "C" fn()) -> bool {
        // SAFETY: both are live AppKit objects, borrowed for the call, on the main thread.
        unsafe { island_install(panel, webview, on_click, on_menu) }
    }

    /// What the island shows. On the main thread.
    pub fn show(pill: bool, tone: &str, words: &str, label: &str) {
        let text = |s: &str| CString::new(s.replace('\0', "")).unwrap_or_default();
        let (tone, words, label) = (text(tone), text(words), text(label));
        // SAFETY: the strings outlive the call, and Swift copies them.
        unsafe { island_show(pill, tone.as_ptr(), words.as_ptr(), label.as_ptr()) }
    }
}

#[cfg(not(target_os = "macos"))]
mod island {
    pub fn show(_pill: bool, _tone: &str, _words: &str, _label: &str) {}
}

/// A click on the island. The page's own handler decides what it means: the
/// camera on or off, or the camera prompt brought back.
extern "C" fn island_clicked() {
    if let Some(window) = APP.get().and_then(|app| app.get_webview_window("orb")) {
        let _ = window.eval("window.orbClick?.()");
    }
}

/// A right-click on the island: the menu.
extern "C" fn island_menu() {
    let Some(app) = APP.get() else { return };
    if let Some(window) = app.get_webview_window("orb") {
        if let Err(err) = orb_menu(app.clone(), window) {
            eprintln!("gesture: couldn't show the orb's menu ({err})");
        }
    }
}

/// A top-left point in CoreGraphics' space as AppKit's bottom-left origin for
/// a frame this tall: AppKit measures y up from the bottom of the main display.
fn appkit_origin(screens: &[Screen], x: f64, y_top: f64, height: f64) -> Option<(f64, f64)> {
    let main = screens.iter().find(|s| s.main)?;
    Some((x, main.height - (y_top + height)))
}

/// Size the orb's panel and keep it centred under the camera.
///
/// One frame change, size and place together. Setting the size and then the
/// position are two separate trips through AppKit, and between them the panel
/// sits at its new size in its old place: the sideways twitch as the pill
/// opened and closed.
fn place_orb(window: &WebviewWindow, width: f64, height: f64) {
    let screens = screens();
    let Some((x, y_top)) = orb_position(&screens, width) else { return };

    #[cfg(target_os = "macos")]
    if let (Some((x, y)), Ok(panel)) = (
        appkit_origin(&screens, x, y_top, height),
        tauri_nspanel::ManagerExt::get_webview_panel(window.app_handle(), "orb"),
    ) {
        use tauri_nspanel::{NSPoint, NSRect, NSSize};
        panel
            .as_panel()
            .setFrame_display(NSRect::new(NSPoint::new(x, y), NSSize::new(width, height)), true);
        return;
    }

    let _ = window.set_size(LogicalSize::new(width, height));
    let _ = window.set_position(LogicalPosition::new(x, y_top));
}

fn create_orb(app: &tauri::AppHandle) -> tauri::Result<()> {
    let url = format!("{SERVER_URL}/orb.html").parse().expect("a valid URL");
    let (width, height) = ORB_PANEL;
    let panel = PanelBuilder::<_, OrbPanel>::new(app, "orb")
        .url(WebviewUrl::External(url))
        .title("Gesture")
        .size(tauri::Size::Logical(LogicalSize::new(width, height)))
        // Above the menu bar, which it sits on, and below menus, which open
        // over it.
        .level(PanelLevel::Status)
        .collection_behavior(
            CollectionBehavior::new()
                .can_join_all_spaces()
                .stationary()
                .full_screen_auxiliary()
                .ignores_cycle(),
        )
        // Clicks never take focus from your app. (Not the plugin's no_activate
        // as well: it bars the whole app from showing windows while the panel
        // is made, and the orb then never appeared.)
        .add_style_mask(StyleMask::empty().nonactivating_panel())
        .transparent(true)
        .has_shadow(false)
        .hides_on_deactivate(false)
        .with_window(|window| {
            window
                .decorations(false)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible_on_all_workspaces(true)
                .transparent(true)
                .shadow(false)
                .focused(false)
                // Shown once it is a panel and in place, not before.
                .visible(false)
                // The first click on the orb is a click, not just a focus.
                .accept_first_mouse(true)
        })
        .build()?;

    if let Some(window) = app.get_webview_window("orb") {
        place_orb(&window, width, height);
        #[cfg(target_os = "macos")]
        {
            let _ = APP.set(app.clone());
            let _ = window.with_webview(|webview| {
                if !island::install(webview.ns_window(), webview.inner(), island_clicked, island_menu) {
                    eprintln!("gesture: couldn't draw the orb's island; only its page will show");
                }
            });
        }
    }
    panel.show();
    pin_orb(&panel);
    report_orb(app.clone());
    Ok(())
}

/// Once macOS has settled the orb, make sure it is really on screen, and say
/// so if it wasn't or still isn't. A see-through panel that is placed wrong,
/// or drawn under something, fails silently otherwise. Quiet when all is well,
/// unless GESTURE_DEBUG is set.
fn report_orb(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        let main = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Ok(panel) = tauri_nspanel::ManagerExt::get_webview_panel(&main, "orb") else {
                eprintln!("gesture: the orb's panel is missing");
                return;
            };
            let window = panel.as_panel();
            if !window.isVisible() {
                println!("gesture: the orb wasn't on screen; showing it again");
                panel.show();
                // Showing puts it back on the current desktop.
                pin_orb(&panel);
            }
            let frame = window.frame();
            let seen = window.occlusionState().contains(objc2_app_kit::NSWindowOcclusionState::Visible);
            if window.isVisible() && seen && !debugging() {
                return;
            }
            println!(
                "gesture: orb at x {} y {} (from the bottom), {}x{} pt, level {}, {}, {}",
                frame.origin.x,
                frame.origin.y,
                frame.size.width,
                frame.size.height,
                window.level(),
                if window.isVisible() { "ordered in" } else { "NOT ordered in" },
                if seen { "visible" } else { "NOT visible (covered or off screen)" },
            );
        });
    });
}

// ------------------------------------------------------------------ commands
//
// What the orb page asks for over IPC. Allowed for the orb window and the
// server's origin only: src-tauri/capabilities/orb.json.

/// What the island shows, from the page: at rest or saying something, the
/// state's colour, Jelly's few words, and the fuller words for VoiceOver.
#[tauri::command]
fn orb_view(window: WebviewWindow, pill: bool, tone: String, words: String, label: String) {
    if debugging() {
        println!("gesture: orb {}: {}", if pill { "says" } else { "rests" }, label.chars().take(100).collect::<String>());
    }
    // AppKit wants its views changed on the main thread.
    let _ = window.run_on_main_thread(move || island::show(pill, &tone, &words, &label));
}

/// GESTURE_DEBUG=1 logs everything the orb shows, and the orb's frame at
/// start.
fn debugging() -> bool {
    std::env::var_os("GESTURE_DEBUG").is_some()
}

/// Right-click: Settings, Start at Login, Quit.
#[tauri::command]
fn orb_menu(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    let settings = MenuItem::with_id(&app, "settings", "Settings…", true, None::<&str>).map_err(|e| e.to_string())?;
    // Reflects the real state rather than a stored preference, so the tick is
    // still right if the LaunchAgent was removed by hand.
    let at_login = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(&app, "autostart", "Start at Login", true, at_login, None::<&str>)
        .map_err(|e| e.to_string())?;
    let separator = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(&app, "quit", "Quit Gesture", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(&app, &[&settings, &autostart, &separator, &quit]).map_err(|e| e.to_string())?;
    window.popup_menu(&menu).map_err(|e| e.to_string())
}

/// Show the engine's window: today's full page, with the gestures list,
/// screens, check-up and Lab. Also how Chrome's camera prompt gets seen.
#[tauri::command]
fn open_settings() {
    SETTINGS_OPEN.store(true, Ordering::SeqCst);
    show_engine(ENGINE_PID.load(Ordering::SeqCst));
}

/// Put the engine's window away again, once the camera prompt is answered.
#[tauri::command]
fn hide_settings() {
    SETTINGS_OPEN.store(false, Ordering::SeqCst);
    hide_engine(ENGINE_PID.load(Ordering::SeqCst));
}

fn quit(app: &tauri::AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    quit_engine(ENGINE_PID.load(Ordering::SeqCst));
    app.exit(0);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_nspanel::init())
        // LaunchAgent rather than a login item: it survives OS upgrades and can
        // be inspected and removed as a plain file, which a login item cannot.
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(ServerProcess(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![orb_view, orb_menu, open_settings, hide_settings])
        .on_menu_event(|app, event| match event.id().as_ref() {
            "settings" => open_settings(),
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
            }
            "quit" => quit(app),
            _ => {}
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // The login item records the app's path when it is switched on, so
            // a moved or replaced app leaves it pointing at nothing. An
            // installed app writes its own path again each time it starts;
            // `tauri dev` doesn't, or logging in would start a dev build.
            #[cfg(not(debug_assertions))]
            if app.autolaunch().is_enabled().unwrap_or(false) {
                if let Err(err) = app.autolaunch().enable() {
                    eprintln!("gesture: could not update the login item ({err})");
                }
            }
            *app.state::<ServerProcess>().0.lock().unwrap() = start_server(&handle);

            // The orb loads its page from the server, and the engine connects
            // to it, so both wait until the server can actually answer.
            std::thread::spawn(move || {
                if !wait_for_server(Duration::from_secs(15)) {
                    eprintln!("gesture: the server never came up on {SERVER_URL}");
                    return;
                }
                println!("gesture: server is up, showing the orb");
                let main = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    if let Err(err) = create_orb(&main) {
                        eprintln!("gesture: could not show the orb ({err})");
                    }
                });
                supervise_engine();
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Gesture app")
        .run(|app, event| match event {
            // Refused except when the request came from Quit: the orb is a
            // panel, and with no ordinary window the app would be asked to exit
            // as soon as it launched.
            RunEvent::ExitRequested { api, .. } => {
                if !QUITTING.load(Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
            // Kill the server on the way out — an orphan holding port 4321 is a
            // confusing thing to debug the next time the app starts — and quit
            // the engine with it.
            RunEvent::Exit => {
                // Set here too: Cmd+Q and the Dock's Quit end the app without
                // going through quit(), and the engine's supervisor would
                // otherwise see the engine go and launch it again on the way out.
                QUITTING.store(true, Ordering::SeqCst);
                quit_engine(ENGINE_PID.load(Ordering::SeqCst));
                #[cfg(target_os = "macos")]
                pinned::release();
                if let Some(mut child) = app.state::<ServerProcess>().0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAPTOP: Screen = Screen { builtin: true, main: false, x: -1512.0, y: 0.0, width: 1512.0, height: 982.0 };
    const BENQ: Screen = Screen { builtin: false, main: true, x: 0.0, y: 0.0, width: 2560.0, height: 1440.0 };

    #[test]
    fn appkit_frames_count_up_from_the_bottom_of_the_main_screen() {
        // A 24 pt tab at the very top of a 1440 pt main screen starts at 1416.
        assert_eq!(appkit_origin(&[BENQ, LAPTOP], 100.0, 0.0, 24.0), Some((100.0, 1416.0)));
        assert_eq!(appkit_origin(&[LAPTOP], 100.0, 0.0, 24.0), None, "no main screen known");
    }

    #[test]
    fn the_orb_goes_under_the_camera_on_the_built_in_screen() {
        assert_eq!(orb_position(&[BENQ, LAPTOP], 60.0), Some((-786.0, 0.0)));
    }

    #[test]
    fn with_the_lid_shut_the_orb_goes_on_the_main_screen() {
        assert_eq!(orb_position(&[BENQ], 360.0), Some((1100.0, 0.0)));
        assert_eq!(orb_position(&[], 60.0), None);
    }

    #[test]
    fn the_engine_is_its_own_profile_and_the_hidden_page() {
        let args = engine_args(Path::new("/Users/me/Library/Application Support/Gesture/Engine"));
        assert!(args.contains(&"--user-data-dir=/Users/me/Library/Application Support/Gesture/Engine".to_string()));
        assert!(args.contains(&format!("--app={SERVER_URL}/?engine=1")));
        assert!(args.contains(&"--disable-backgrounding-occluded-windows".to_string()));
    }

    #[test]
    fn the_engine_is_found_by_its_profile_and_not_its_helpers() {
        let profile = Path::new("/Users/me/Library/Application Support/Gesture/Engine");
        let ps = "\
  101 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  202 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --user-data-dir=/Users/me/Library/Application Support/Gesture/Engine
  303 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/me/Library/Application Support/Gesture/Engine --app=http://127.0.0.1:4321/?engine=1
";
        assert_eq!(engine_pid_in(ps, profile), Some(303));
        assert_eq!(engine_pid_in("  101 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n", profile), None);
    }
}
