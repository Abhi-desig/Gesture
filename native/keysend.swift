// keysend — post a key chord as *real* events, modifiers included.
//
// Why this exists at all: libnut sets the modifier bit with CGEventSetFlags on
// the key event itself and never emits a kCGEventFlagsChanged event for the
// modifier. It cannot: `nm` on libnut.node shows CGEventCreateKeyboardEvent,
// CGEventSetFlags and CGEventPost, and no CGEventSetType anywhere in the binary
// — and CGEventSetType is the only way to turn a keyboard event into a
// flagsChanged one.
//
// That split is the whole bug. Applications read flags straight off the event,
// so Chrome sees a genuine Ctrl+Right and acts on it. macOS matches symbolic
// hotkeys — Mission Control's "Move left/right a space" among them — against the
// WindowServer's *global* modifier state, which only flagsChanged updates. So
// the chord works inside the focused app and never reaches Mission Control.
//
// Everything here is posted at .cghidEventTap, the same place a real keyboard
// injects, so the WindowServer sees the modifier go down and come back up.
//
// Usage:
//   keysend key   <keycode> [cmd] [ctrl] [alt] [shift] [options]
//   keysend media <nx-type> [cmd] [ctrl] [alt] [shift] [options]
//   keysend swipe <left|right> [options]
//   keysend space <left|right>              (direct WindowServer call)
//   keysend displays                        (JSON list of displays)
//   keysend focus <display-id> [--no-pointer]
//   keysend move  <display-id> [--no-pointer]
//
// Options:
//   --source=hid|combined|private|null   event source state table (default hid)
//   --delay-us=<n>                       pause between posted events (default 12000)
//   --variant=iss|mmf                    dock-swipe field layout (default iss)
//   --velocity=<n>                       dock-swipe exit speed (default 400)
//   --no-pointer                         focus/move leave the mouse pointer alone
//   --verbose                            describe every posted event on stderr
//
// Exit: 0 on success, 1 on bad arguments or an event that could not be built,
// 4 when focus/move are refused because Accessibility is not granted.
//
// ---------------------------------------------------------------------------
// A NOTE ON `swipe`, WHICH IS NOT A KEY PRESS
//
// macOS refuses to switch Spaces from a synthesized Ctrl+Arrow. Not "libnut
// can't", not "the wrong event source" — the WindowServer declines to match
// *any* injected key against the Space-navigation hotkeys, while still handing
// the keystroke to the focused application. Measured on macOS 26.4: nut.js two
// ways, this helper's flagsChanged at all four source state tables, and
// osascript via System Events all failed identically, and the terminal echoed
// ^[[1;5C each time — proof the key arrived somewhere. The same helper switching
// to `ctrl+up` triggers Mission Control, so this is specific to Space
// navigation rather than a blanket block on synthetic input.
//
// So this path stops pretending to be a keyboard. It posts the *trackpad*
// gesture the Dock listens for — a three-finger dock swipe — which is how
// Mac Mouse Fix, BetterTouchTool and similar tools have always done it.
//
// The field indices below are undocumented. They are stable in practice (they
// predate Mission Control's current implementation) but they are reverse
// engineered, not API, and Apple has changed them: the payload layout moved
// again in the macOS 27 betas. Hence `--velocity`, and hence this being one
// backend among several rather than the only way the app can press a key.
// ---------------------------------------------------------------------------

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// Virtual keycodes for the left-hand modifier keys. These are what a real
// keyboard sends; the flag bit alone is not enough.
private let MODIFIER_KEYCODES: [String: (CGKeyCode, CGEventFlags)] = [
  "cmd": (55, .maskCommand),
  "shift": (56, .maskShift),
  "alt": (58, .maskAlternate),
  "ctrl": (59, .maskControl),
]

// The order modifiers are pressed in. Fixed rather than argument order, so the
// same chord always produces the same event sequence.
private let MODIFIER_ORDER = ["cmd", "ctrl", "alt", "shift"]

private func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("keysend: \(message)\n".utf8))
  exit(1)
}

// ------------------------------------------------------------------ arguments

// Which state table the synthesized events are attributed to.
//
// This is a real variable, not a detail. The fix depends on the WindowServer's
// *global* modifier state being updated, and a source's state ID is what decides
// whose state that is:
//
//   hid       .hidSystemState — the hardware's own table. Closest thing to a
//             real keyboard, and the default for that reason.
//   combined  .combinedSessionState — the login session's combined table.
//   private   .privateState — a table nobody else reads. Isolates the chord from
//             modifiers the user is physically holding, at the risk of being
//             exactly as invisible to the WindowServer as libnut's flag bit.
//   null      no source at all; CoreGraphics picks.
//
// Exposed rather than hardcoded because which of these actually moves a Space is
// an empirical question, and `scripts/keysend-probe.mjs` answers it by sending
// the same chord through each one and reading com.apple.spaces after each.
private let SOURCE_STATES: [String: CGEventSourceStateID] = [
  "hid": .hidSystemState,
  "combined": .combinedSessionState,
  "private": .privateState,
]

private var sourceName = "hid"
private var stepDelayUs: UInt32 = 12_000
private var swipeVelocity = 400.0
private var swipeVariant = "iss"
private var lingerMs = 0.0
private var withTap = false
private var verbose = false
private var movePointer = true
private var positional: [String] = []

for arg in CommandLine.arguments.dropFirst() {
  if arg == "--verbose" {
    verbose = true
  } else if arg == "--no-pointer" {
    movePointer = false
  } else if arg.hasPrefix("--source=") {
    sourceName = String(arg.dropFirst("--source=".count))
    guard sourceName == "null" || SOURCE_STATES[sourceName] != nil else {
      fail("--source must be one of hid, combined, private, null (got \"\(sourceName)\")")
    }
  } else if arg.hasPrefix("--delay-us=") {
    guard let value = UInt32(arg.dropFirst("--delay-us=".count)), value <= 1_000_000 else {
      fail("--delay-us must be a whole number of microseconds up to 1000000")
    }
    stepDelayUs = value
  } else if arg == "--with-tap" {
    withTap = true
  } else if arg.hasPrefix("--linger-ms=") {
    guard let value = Double(arg.dropFirst("--linger-ms=".count)), value >= 0, value <= 10_000 else {
      fail("--linger-ms must be between 0 and 10000")
    }
    lingerMs = value
  } else if arg.hasPrefix("--variant=") {
    swipeVariant = String(arg.dropFirst("--variant=".count))
    guard swipeVariant == "iss" || swipeVariant == "mmf" else {
      fail("--variant must be \"iss\" or \"mmf\" (got \"\(swipeVariant)\")")
    }
  } else if arg.hasPrefix("--velocity=") {
    guard let value = Double(arg.dropFirst("--velocity=".count)), value > 0, value <= 100_000 else {
      fail("--velocity must be a positive number up to 100000")
    }
    swipeVelocity = value
  } else if arg.hasPrefix("--") {
    fail("unknown option \"\(arg)\"")
  } else {
    positional.append(arg)
  }
}

// ------------------------------------------------------------------ screens
//
// The spatial half: which displays exist, and acting on the window that sits on
// one of them. All public API — CoreGraphics for the display and window lists,
// the Accessibility API to focus and move windows — under the same
// Accessibility grant that key presses already need. The window list itself
// needs no Screen Recording permission: that only gates window *titles* from
// CGWindowList, and titles here come from the Accessibility API instead.
//
// Coordinates are CoreGraphics global points: origin at the top-left of the
// main display, y down. The Accessibility API reports window positions in the
// same space, so the two compare directly. AppKit's NSScreen frames are the odd
// one out — origin bottom-left — and are converted once, in visibleBounds.

private let EXIT_NOT_TRUSTED: Int32 = 4

/// Print one JSON object and exit. JSON rather than prose for the same reason
/// `space status` is: the server reads this, and it should not parse sentences.
private func emit(_ object: [String: Any]) -> Never {
  guard
    let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
    let text = String(data: data, encoding: .utf8)
  else { fail("could not encode the result as JSON") }
  print(text)
  exit(0)
}

private func activeDisplays() -> [CGDirectDisplayID] {
  var count: UInt32 = 0
  guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
  return Array(ids.prefix(Int(count)))
}

private func screenFor(_ id: CGDirectDisplayID) -> NSScreen? {
  NSScreen.screens.first {
    ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id
  }
}

/// The part of a display a window may occupy — below the menu bar, clear of the
/// Dock — in CG global coordinates. Falls back to the whole display when AppKit
/// has no screen for the id, which costs a window tucked under the menu bar and
/// nothing worse.
private func visibleBounds(_ id: CGDirectDisplayID) -> CGRect {
  let full = CGDisplayBounds(id)
  guard let screen = screenFor(id), let primary = NSScreen.screens.first else { return full }
  let v = screen.visibleFrame
  // AppKit measures y up from the bottom of the primary display, CG measures it
  // down from the top. The primary display sits at the origin in both, so its
  // height is the whole conversion.
  return CGRect(x: v.minX, y: primary.frame.height - v.maxY, width: v.width, height: v.height)
}

private func describeDisplay(_ id: CGDirectDisplayID) -> [String: Any] {
  let b = CGDisplayBounds(id)
  return [
    "id": Int(id),
    "name": screenFor(id)?.localizedName ?? "Display \(id)",
    "x": Double(b.minX),
    "y": Double(b.minY),
    "width": Double(b.width),
    "height": Double(b.height),
    "main": CGDisplayIsMain(id) != 0,
    "builtin": CGDisplayIsBuiltin(id) != 0,
  ]
}

/// Refuse loudly rather than act silently. Without Accessibility every AX call
/// below fails with an error nobody reads, and the window simply stays put —
/// the same "it fired and nothing happened" the key path already had to fix.
private func requireTrust() {
  guard AXIsProcessTrusted() else {
    FileHandle.standardError.write(Data("keysend: Accessibility access is not granted\n".utf8))
    exit(EXIT_NOT_TRUSTED)
  }
}

private func axElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
    let value, CFGetTypeID(value) == AXUIElementGetTypeID()
  else { return nil }
  return (value as! AXUIElement)
}

private func axElements(_ element: AXUIElement, _ attribute: String) -> [AXUIElement] {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
    return []
  }
  return (value as? [AXUIElement]) ?? []
}

private func axString(_ element: AXUIElement, _ attribute: String) -> String? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
    return nil
  }
  return value as? String
}

private func axFrame(_ window: AXUIElement) -> CGRect? {
  var positionRef: CFTypeRef?
  var sizeRef: CFTypeRef?
  guard
    AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &positionRef) == .success,
    AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeRef) == .success,
    let positionRef, let sizeRef,
    CFGetTypeID(positionRef) == AXValueGetTypeID(), CFGetTypeID(sizeRef) == AXValueGetTypeID()
  else { return nil }
  var origin = CGPoint.zero
  var size = CGSize.zero
  AXValueGetValue(positionRef as! AXValue, .cgPoint, &origin)
  AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
  return CGRect(origin: origin, size: size)
}

/// Size, then position, then size again. An app that keeps its window inside
/// the current screen would otherwise clamp a size that only fits the
/// destination, or refuse a position the old size would overflow — the same
/// sequence window managers like Rectangle settled on.
private func setFrame(_ window: AXUIElement, _ frame: CGRect) -> Bool {
  var origin = frame.origin
  var size = frame.size
  guard let position = AXValueCreate(.cgPoint, &origin), let extent = AXValueCreate(.cgSize, &size)
  else { return false }
  AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, extent)
  let moved = AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, position)
  AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, extent)
  return moved == .success
}

/// Make an app frontmost and one of its windows key.
///
/// AXFrontmost rather than NSRunningApplication.activate alone: since macOS 14
/// activation is cooperative, and a background helper asking another app to
/// come forward is exactly the request it is allowed to ignore. The
/// Accessibility route is not subject to that, and activate() stays as a
/// second voice for older systems.
private func bringForward(pid: pid_t, window: AXUIElement?) {
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
  if let window {
    AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
  }
  if #available(macOS 14.0, *) {
    NSRunningApplication(processIdentifier: pid)?.activate()
  } else {
    NSRunningApplication(processIdentifier: pid)?.activate(options: [])
  }
}

/// Put the pointer where the attention now is, so the next scroll or click lands
/// on the window that just came forward instead of on the screen you left.
private func warpPointer(to point: CGPoint) {
  guard movePointer else { return }
  CGWarpMouseCursorPosition(point)
  // A warp briefly decouples the pointer from the physical mouse; re-coupling
  // straight away means the next real movement isn't swallowed.
  CGAssociateMouseAndMouseCursorPosition(1)
}

private func displayArgument() -> CGDirectDisplayID {
  guard positional.count == 2, let raw = UInt32(positional[1]) else {
    fail("\(positional[0]) takes one display id — see \"keysend displays\"")
  }
  guard activeDisplays().contains(raw) else {
    fail("display \(raw) is not connected — see \"keysend displays\"")
  }
  return raw
}

/// The frontmost ordinary window whose centre lies on `display`.
private func frontWindow(on display: CGDirectDisplayID) -> (pid: pid_t, frame: CGRect, owner: String)? {
  let bounds = CGDisplayBounds(display)
  let me = getpid()
  // Front to back. Layer 0 is ordinary application windows; the menu bar, the
  // Dock, notifications and floating panels all live on other layers.
  let entries =
    (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]]) ?? []
  for entry in entries {
    guard
      (entry[kCGWindowLayer as String] as? Int) == 0,
      let pid = entry[kCGWindowOwnerPID as String] as? pid_t, pid != me,
      let rawBounds = entry[kCGWindowBounds as String] as? NSDictionary,
      let frame = CGRect(dictionaryRepresentation: rawBounds as CFDictionary),
      // Below this it is a tooltip-sized utility window, not something you
      // would mean by "the window on that screen".
      frame.width >= 80, frame.height >= 60,
      (entry[kCGWindowAlpha as String] as? Double ?? 1) > 0
    else { continue }
    // A window belongs to the display holding its centre, which is also how
    // macOS decides where a window straddling two screens "is".
    if bounds.contains(CGPoint(x: frame.midX, y: frame.midY)) {
      return (pid, frame, entry[kCGWindowOwnerName as String] as? String ?? "?")
    }
  }
  return nil
}

if positional.first == "displays" {
  // No permission needed: this is read-only and describes hardware, not windows.
  let displays = activeDisplays().map(describeDisplay)
  guard
    let data = try? JSONSerialization.data(withJSONObject: displays, options: [.sortedKeys]),
    let text = String(data: data, encoding: .utf8)
  else { fail("could not encode the display list") }
  print(text)
  exit(0)
}

if positional.first == "focus" {
  let display = displayArgument()
  requireTrust()

  guard let target = frontWindow(on: display) else {
    // Nothing to focus — an empty desktop. Still worth moving the pointer:
    // it is the one visible sign that the screen you looked at was the one
    // that was picked.
    let b = CGDisplayBounds(display)
    warpPointer(to: CGPoint(x: b.midX, y: b.midY))
    emit(["display": Int(display), "focused": false, "reason": "no window on that display"])
  }

  // Match the CoreGraphics window to its Accessibility element by frame: the
  // two APIs share a coordinate space, and the public API offers no id that
  // links them.
  let windows = axElements(AXUIElementCreateApplication(target.pid), kAXWindowsAttribute)
  let window = windows.first { w in
    guard let f = axFrame(w) else { return false }
    return abs(f.minX - target.frame.minX) < 4 && abs(f.minY - target.frame.minY) < 4
      && abs(f.width - target.frame.width) < 4 && abs(f.height - target.frame.height) < 4
  }

  bringForward(pid: target.pid, window: window)
  warpPointer(to: CGPoint(x: target.frame.midX, y: target.frame.midY))
  emit([
    "display": Int(display),
    "focused": true,
    "app": target.owner,
    "window": window.flatMap { axString($0, kAXTitleAttribute) } ?? "",
  ])
}

if positional.first == "move" {
  let display = displayArgument()
  requireTrust()

  let system = AXUIElementCreateSystemWide()
  guard let app = axElement(system, kAXFocusedApplicationAttribute) else {
    fail("no application has focus")
  }
  guard
    let window = axElement(app, kAXFocusedWindowAttribute) ?? axElement(app, kAXMainWindowAttribute)
  else { fail("the focused application has no window to move") }
  guard let frame = axFrame(window) else { fail("could not read the focused window's frame") }

  var pid: pid_t = 0
  AXUIElementGetPid(app, &pid)
  let owner = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "?"
  let title = axString(window, kAXTitleAttribute) ?? ""

  var source: CGDirectDisplayID = 0
  var matches: UInt32 = 0
  CGGetDisplaysWithPoint(CGPoint(x: frame.midX, y: frame.midY), 1, &source, &matches)
  if matches == 0 { source = CGMainDisplayID() }
  if source == display {
    emit(["moved": false, "reason": "already on that display", "app": owner, "window": title,
          "from": Int(source), "to": Int(display)])
  }

  // The same place, proportionally: a window in the top-left of one screen
  // lands in the top-left of the other, measured in the room it had to move
  // around in. Shrunk only when it would not fit at all.
  let from = visibleBounds(source)
  let to = visibleBounds(display)
  let size = CGSize(width: min(frame.width, to.width), height: min(frame.height, to.height))
  func share(_ offset: CGFloat, _ slack: CGFloat) -> CGFloat {
    slack > 0 ? min(max(offset / slack, 0), 1) : 0
  }
  let rx = share(frame.minX - from.minX, from.width - frame.width)
  let ry = share(frame.minY - from.minY, from.height - frame.height)
  let landing = CGRect(
    x: to.minX + rx * (to.width - size.width),
    y: to.minY + ry * (to.height - size.height),
    width: size.width,
    height: size.height)

  guard setFrame(window, landing) else {
    // The usual cause, named: a full-screen window owns its own Space and
    // cannot be positioned at all.
    fail("\(owner) would not let its window move — a full-screen window cannot leave its Space")
  }
  bringForward(pid: pid, window: window)
  warpPointer(to: CGPoint(x: landing.midX, y: landing.midY))
  emit(["moved": true, "app": owner, "window": title, "from": Int(source), "to": Int(display)])
}

guard positional.count >= 2 else {
  fail("usage: keysend key|media <code> [cmd] [ctrl] [alt] [shift] [--source=…]")
}

let kind = positional[0]
guard kind == "key" || kind == "media" || kind == "swipe" || kind == "space" else {
  fail("first argument must be key, media, swipe, space, displays, focus or move — got \"\(kind)\"")
}

// `swipe` and `space` take a direction; the other two take a numeric code.
var code = 0
var swipeDirection = ""
if kind == "swipe" || kind == "space" {
  swipeDirection = positional[1]
  let allowed = kind == "space" ? ["left", "right", "status"] : ["left", "right"]
  guard allowed.contains(swipeDirection) else {
    fail("\(kind) direction must be one of \(allowed.joined(separator: ", ")), got \"\(swipeDirection)\"")
  }
  guard positional.count == 2 else {
    fail("\(kind) takes no modifiers — it is not a key chord")
  }
} else {
  guard let parsed = Int(positional[1]), parsed >= 0, parsed <= 0xFFFF else {
    fail("\"\(positional[1])\" is not a code between 0 and 65535")
  }
  code = parsed
}

var requested: [String] = []
for name in positional.dropFirst(2) {
  guard MODIFIER_KEYCODES[name] != nil else { fail("unknown modifier \"\(name)\"") }
  if !requested.contains(name) { requested.append(name) }
}
let modifiers = MODIFIER_ORDER.filter { requested.contains($0) }

let source: CGEventSource?
if sourceName == "null" {
  source = nil
} else {
  guard let created = CGEventSource(stateID: SOURCE_STATES[sourceName]!) else {
    fail("could not create a CGEventSource for --source=\(sourceName)")
  }
  // A synthetic event otherwise suppresses real hardware input for 0.25s. The
  // user is not meant to notice this helper ran at all.
  created.localEventsSuppressionInterval = 0
  source = created
}

// ------------------------------------------------------------------ posting

private func trace(_ what: String, _ detail: String) {
  guard verbose else { return }
  FileHandle.standardError.write(Data("keysend: \(what) \(detail)\n".utf8))
}

/// A flagsChanged event has to be built as a key event and then re-typed —
/// CGEvent has no flagsChanged initialiser. This is the step libnut is missing.
private func postFlagsChanged(key: CGKeyCode, flags: CGEventFlags, down: Bool) {
  guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else {
    // Loudly, not silently. A modifier that quietly failed to go down is the
    // precise failure this whole helper exists to eliminate; swallowing it here
    // would reproduce the original bug with better comments.
    fail("could not create a flagsChanged event for keycode \(key)")
  }
  event.type = .flagsChanged
  event.flags = flags
  event.post(tap: .cghidEventTap)
  trace("flagsChanged", "keycode=\(key) down=\(down) flags=0x\(String(flags.rawValue, radix: 16))")
  usleep(stepDelayUs)
}

private func postKey(_ key: CGKeyCode, flags: CGEventFlags, down: Bool) {
  guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else {
    fail("could not create a key event for keycode \(key)")
  }
  event.flags = flags
  event.post(tap: .cghidEventTap)
  trace(down ? "keyDown" : "keyUp", "keycode=\(key) flags=0x\(String(flags.rawValue, radix: 16))")
  usleep(stepDelayUs)
}

/// Play/pause, volume and track keys are not virtual keycodes at all — they are
/// NSSystemDefined events carrying an NX_KEYTYPE_* code, which is why they need
/// a separate path from every other key.
private func postMedia(_ nxType: Int, down: Bool) {
  let phase = down ? 0xA : 0xB
  guard
    let event = NSEvent.otherEvent(
      with: .systemDefined,
      location: .zero,
      modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(phase << 8)),
      timestamp: 0,
      windowNumber: 0,
      context: nil,
      subtype: 8, // NX_SUBTYPE_AUX_CONTROL_BUTTONS
      data1: (nxType << 16) | (phase << 8),
      data2: -1
    ), let cg = event.cgEvent
  else {
    fail("could not create a system-defined event for NX type \(nxType)")
  }
  cg.post(tap: .cghidEventTap)
  trace("media", "nxType=\(nxType) down=\(down)")
  usleep(stepDelayUs)
}

// ------------------------------------------------------------- dock swipe
//
// Undocumented CGEvent fields. Named after the constants they correspond to so
// the numbers are not the only thing here.
private let FIELD_CGS_EVENT_TYPE: UInt32 = 55
private let FIELD_GESTURE_HID_TYPE: UInt32 = 110
private let FIELD_GESTURE_SCROLL_Y: UInt32 = 119
private let FIELD_SWIPE_MOTION: UInt32 = 123
private let FIELD_SWIPE_VELOCITY_X: UInt32 = 129
private let FIELD_SWIPE_VELOCITY_Y: UInt32 = 130
private let FIELD_GESTURE_PHASE: UInt32 = 132
private let FIELD_SCROLL_GESTURE_FLAG_BITS: UInt32 = 135
private let FIELD_ZOOM_DELTA_X: UInt32 = 139

private let CGS_EVENT_GESTURE: Int64 = 29
private let CGS_EVENT_DOCK_CONTROL: Int64 = 30
private let HID_EVENT_TYPE_DOCK_SWIPE: Int64 = 23
private let GESTURE_MOTION_HORIZONTAL: Int64 = 1

private let PHASE_BEGAN: Int64 = 1
private let PHASE_CHANGED: Int64 = 2
private let PHASE_ENDED: Int64 = 4

private func field(_ raw: UInt32) -> CGEventField {
  guard let f = CGEventField(rawValue: raw) else { fail("bad CGEventField \(raw)") }
  return f
}

// Extra fields the Mac Mouse Fix variant sets and iss does not.
private let FIELD_SWIPE_PROGRESS: UInt32 = 124
private let FIELD_GESTURE_PHASE_ALIAS: UInt32 = 134
private let FIELD_SWIPE_INVERTED: UInt32 = 136
private let FIELD_SWIPE_MOTION_ALIAS: UInt32 = 165

/// The smallest non-zero float, which both references use as a magic marker.
private let TINY = Double(Float.leastNonzeroMagnitude)

/// A DockControl event carrying the fields common to all three phases.
///
/// Two variants, because the two working implementations disagree and neither
/// is documentation. `iss` writes field 119 as 0 and puts the marker in 139;
/// Mac Mouse Fix writes the marker into 119 (where it encodes horizontal vs
/// vertical vs pinch) and mirrors it into 139. They also differ on the sign of
/// field 135: iss reinterprets the float bits as int32, MMF as uint32, and its
/// source is emphatic that unsigned is required. Only one of these is right for
/// macOS 26.4 and the way to find out is to send both.
private func makeDockEvent(phase: Int64, right: Bool) -> CGEvent {
  guard let event = CGEvent(source: nil) else {
    fail("could not create a dock swipe event")
  }

  event.setIntegerValueField(field(FIELD_CGS_EVENT_TYPE), value: CGS_EVENT_DOCK_CONTROL)
  event.setIntegerValueField(field(FIELD_GESTURE_HID_TYPE), value: HID_EVENT_TYPE_DOCK_SWIPE)
  event.setIntegerValueField(field(FIELD_GESTURE_PHASE), value: phase)
  event.setIntegerValueField(field(FIELD_SWIPE_MOTION), value: GESTURE_MOTION_HORIZONTAL)

  if swipeVariant == "mmf" {
    // A full swipe's worth of travel, with field 135 carrying the same number
    // re-encoded as raw float bits — MMF derives one from the other, so they
    // are kept consistent here rather than mixed between conventions.
    let offset: Float = right ? -1.0 : 1.0
    event.setDoubleValueField(field(FIELD_SWIPE_PROGRESS), value: Double(offset))
    event.setIntegerValueField(field(FIELD_SCROLL_GESTURE_FLAG_BITS),
                               value: Int64(offset.bitPattern))
    event.setDoubleValueField(field(FIELD_GESTURE_SCROLL_Y), value: TINY)
    event.setDoubleValueField(field(FIELD_ZOOM_DELTA_X), value: TINY)
    event.setIntegerValueField(field(FIELD_GESTURE_PHASE_ALIAS), value: phase)
    event.setIntegerValueField(field(FIELD_SWIPE_MOTION_ALIAS), value: GESTURE_MOTION_HORIZONTAL)
    event.setIntegerValueField(field(FIELD_SWIPE_INVERTED), value: 0)
    return event
  }

  // iss: the direction hint is the *bit pattern* of a ±FLT_TRUE_MIN float
  // reinterpreted as int32 — the smallest possible non-zero magnitude, so it
  // reads as "moved, infinitesimally", which is what makes the switch instant
  // rather than animated.
  let progress: Float = right ? .leastNonzeroMagnitude : -.leastNonzeroMagnitude
  event.setIntegerValueField(field(FIELD_SCROLL_GESTURE_FLAG_BITS),
                             value: Int64(Int32(bitPattern: progress.bitPattern)))
  event.setDoubleValueField(field(FIELD_GESTURE_SCROLL_Y), value: 0)
  event.setDoubleValueField(field(FIELD_ZOOM_DELTA_X), value: TINY)
  return event
}

/// Post a DockControl event followed by its companion gesture event.
///
/// The companion is not decoration. A bare DockControl event is ignored; the
/// Dock expects the pair, and posting only the first is why an otherwise
/// correct-looking swipe does nothing at all.
private func postPair(_ dock: CGEvent) {
  guard let companion = CGEvent(source: nil) else {
    fail("could not create the companion gesture event")
  }
  companion.setIntegerValueField(field(FIELD_CGS_EVENT_TYPE), value: CGS_EVENT_GESTURE)

  // The session tap, NOT the HID tap. Key events go in at the HID level because
  // that is where a keyboard sits; these are consumed by the Dock inside the
  // login session, and posting them lower down means nothing receives them.
  dock.post(tap: .cgSessionEventTap)
  companion.post(tap: .cgSessionEventTap)
}

/// Install a session-level event tap for the gesture and DockControl events.
///
/// Not to intercept anything — the callback passes everything straight through.
/// It exists because both working implementations of this hold one, and neither
/// posts a dock swipe from a process that doesn't. Whether the WindowServer
/// actually requires the poster to be a tap owner, or whether those programs
/// simply happen to be daemons, is exactly the question this answers.
private func installPassthroughTap() {
  let mask: CGEventMask = (1 << CGS_EVENT_GESTURE) | (1 << CGS_EVENT_DOCK_CONTROL)
  guard
    let tap = CGEvent.tapCreate(
      tap: .cgSessionEventTap,
      place: .headInsertEventTap,
      options: .defaultTap,
      eventsOfInterest: mask,
      callback: { _, _, event, _ in Unmanaged.passUnretained(event) },
      userInfo: nil
    )
  else {
    fail("could not create the event tap (is Accessibility granted?)")
  }

  let source = CFMachPortCreateRunLoopSource(nil, tap, 0)
  CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
  CGEvent.tapEnable(tap: tap, enable: true)
  trace("tap", "session tap installed for gesture+dockControl")
}

// ------------------------------------------------------------- direct space
//
// Neither a key nor a gesture: ask the WindowServer to change Space outright.
//
// These are private CoreGraphics/SkyLight symbols, resolved with dlsym rather
// than linked, so a future macOS that drops one produces a clear error here
// instead of a binary that refuses to launch. They are not API and carry no
// compatibility promise — but every public route to Space navigation is closed
// on macOS 26, so the choice is this or nothing.
//
// Known tradeoff: this moves the Space without going through the Dock, so
// keyboard focus can stay with the app you left. Worth measuring before
// worrying about — a Space that changes with stale focus is still a Space that
// changed, which is more than anything else here has managed.

private typealias MainConnectionIDFn = @convention(c) () -> Int32
private typealias GetActiveSpaceFn = @convention(c) (Int32) -> UInt64
private typealias CopyManagedDisplaySpacesFn = @convention(c) (Int32) -> Unmanaged<CFArray>?
private typealias SetCurrentSpaceFn = @convention(c) (Int32, CFString, UInt64) -> Void

private func skylightSymbol(_ name: String) -> UnsafeMutableRawPointer {
  let paths = [
    "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
    "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics",
  ]
  for path in paths {
    guard let handle = dlopen(path, RTLD_LAZY) else { continue }
    if let symbol = dlsym(handle, name) { return symbol }
  }
  fail("this macOS does not export \(name) — the direct Space API is gone")
}

/// Every ManagedSpaceID on the display holding `active`, plus that display's id.
private func spacesForActiveDisplay(_ displays: [[String: Any]], active: UInt64)
  -> (display: String, ids: [UInt64])?
{
  for entry in displays {
    guard
      let identifier = entry["Display Identifier"] as? String,
      let spaces = entry["Spaces"] as? [[String: Any]]
    else { continue }

    let ids: [UInt64] = spaces.compactMap {
      ($0["ManagedSpaceID"] as? NSNumber)?.uint64Value ?? ($0["id64"] as? NSNumber)?.uint64Value
    }
    if ids.contains(active) { return (identifier, ids) }
  }
  return nil
}

if kind == "space" {
  let mainConnectionID = unsafeBitCast(skylightSymbol("CGSMainConnectionID"), to: MainConnectionIDFn.self)
  let getActiveSpace = unsafeBitCast(skylightSymbol("CGSGetActiveSpace"), to: GetActiveSpaceFn.self)
  let copySpaces = unsafeBitCast(
    skylightSymbol("CGSCopyManagedDisplaySpaces"), to: CopyManagedDisplaySpacesFn.self)
  let setCurrentSpace = unsafeBitCast(
    skylightSymbol("CGSManagedDisplaySetCurrentSpace"), to: SetCurrentSpaceFn.self)

  let cid = mainConnectionID()
  let active = getActiveSpace(cid)
  guard let displays = copySpaces(cid)?.takeRetainedValue() as? [[String: Any]] else {
    fail("CGSCopyManagedDisplaySpaces returned nothing usable")
  }

  // The WindowServer's own answer, not the Dock's cached copy in
  // com.apple.spaces. Those differ: the preference domain is written by the
  // Dock, so a Space changed by any route that bypasses the Dock will not show
  // up there. Measuring this the wrong way turns a working switch into a
  // reported failure.
  if swipeDirection == "status" {
    // JSON, because this is the measurement every other part of the project
    // depends on and it should not need parsing prose.
    var displayJSON: [String] = []
    for entry in displays {
      let identifier = (entry["Display Identifier"] as? String) ?? "?"
      let spaces = (entry["Spaces"] as? [[String: Any]]) ?? []
      let ids = spaces.compactMap {
        ($0["ManagedSpaceID"] as? NSNumber)?.uint64Value ?? ($0["id64"] as? NSNumber)?.uint64Value
      }
      let index = ids.firstIndex(of: active).map { String($0) } ?? "null"
      displayJSON.append(
        "{\"display\":\"\(identifier)\",\"spaces\":[\(ids.map(String.init).joined(separator: ","))],"
          + "\"activeIndex\":\(index)}")
    }
    print("{\"active\":\(active),\"displays\":[\(displayJSON.joined(separator: ","))]}")
    exit(0)
  }
  guard let (display, ids) = spacesForActiveDisplay(displays, active: active) else {
    fail("could not find the active Space (\(active)) on any display")
  }
  guard let index = ids.firstIndex(of: active) else {
    fail("active Space \(active) is not in its own display's list")
  }

  let target = swipeDirection == "right" ? index + 1 : index - 1
  guard target >= 0, target < ids.count else {
    // Not an error: you asked to move past the end. Say so and succeed, so a
    // gesture at the edge doesn't look like a broken backend.
    trace("space", "already at the \(swipeDirection) end (\(index + 1) of \(ids.count))")
    exit(0)
  }

  trace("space", "display=\(display) \(index + 1)/\(ids.count) -> \(target + 1)/\(ids.count)")
  trace("space", "active=\(active) target=\(ids[target])")
  setCurrentSpace(cid, display as CFString, ids[target])

  // Read the WindowServer back immediately. This is the only honest check: the
  // Dock's preference file will not reflect a switch it did not perform.
  let now = getActiveSpace(cid)
  trace("space", now == ids[target]
    ? "confirmed: active is now \(now)"
    : "NOT applied: active is still \(now), wanted \(ids[target])")
  exit(now == ids[target] ? 0 : 3)
}

if kind == "swipe" {
  if withTap { installPassthroughTap() }
  let right = swipeDirection == "right"
  // iss and MMF also disagree here: iss signs the exit velocity positive for a
  // rightward switch, MMF derives it from the same direction as its offset.
  let sign = swipeVariant == "mmf" ? (right ? -1.0 : 1.0) : (right ? 1.0 : -1.0)
  trace("source",
        "dock swipe \(swipeDirection) variant=\(swipeVariant) velocity=\(swipeVelocity) tap=session")

  let begin = makeDockEvent(phase: PHASE_BEGAN, right: right)
  let changed = makeDockEvent(phase: PHASE_CHANGED, right: right)
  let end = makeDockEvent(phase: PHASE_ENDED, right: right)

  // Velocity rides only on the final event: it is the flick that tells the Dock
  // to complete the switch instead of rubber-banding back to where it started.
  end.setDoubleValueField(field(FIELD_SWIPE_VELOCITY_X), value: sign * swipeVelocity)
  // iss leaves Y at zero; MMF sets both axes to the same exit speed.
  end.setDoubleValueField(field(FIELD_SWIPE_VELOCITY_Y),
                          value: swipeVariant == "mmf" ? sign * swipeVelocity : 0)

  // Back to back, with no pause. The three phases are one gesture, and spacing
  // them out invites the Dock to interpret the gap as a hesitation.
  postPair(begin)
  trace("dockSwipe", "phase=began direction=\(swipeDirection)")
  postPair(changed)
  trace("dockSwipe", "phase=changed")
  postPair(end)
  trace("dockSwipe", "phase=ended velocityX=\(sign * swipeVelocity)")

  // Stay alive, running the run loop, rather than exiting the instant the last
  // event is queued. CGEventPost is asynchronous, and both reference
  // implementations are long-lived daemons — a process that dies microseconds
  // after posting a three-phase gesture may simply not be around long enough
  // for the Dock to finish acting on it.
  if lingerMs > 0 {
    trace("linger", "\(lingerMs)ms")
    CFRunLoopRunInMode(.defaultMode, lingerMs / 1000.0, false)
  }
  exit(0)
}

trace("source", "\(sourceName) delay=\(stepDelayUs)us modifiers=[\(modifiers.joined(separator: ","))]")

// Press modifiers one at a time, each flagsChanged carrying the flags
// accumulated so far — exactly what a keyboard produces.
var flags: CGEventFlags = []
for name in modifiers {
  let (modKey, modFlag) = MODIFIER_KEYCODES[name]!
  flags.insert(modFlag)
  postFlagsChanged(key: modKey, flags: flags, down: true)
}

if kind == "media" {
  postMedia(code, down: true)
  postMedia(code, down: false)
} else {
  let keycode = CGKeyCode(code)
  postKey(keycode, flags: flags, down: true)
  postKey(keycode, flags: flags, down: false)
}

// Release in reverse, clearing one bit per event, ending at empty. Unconditional
// so a modifier can never be left stuck down — a Control stuck down turns every
// subsequent keystroke on the machine into a control chord.
for name in modifiers.reversed() {
  let (modKey, modFlag) = MODIFIER_KEYCODES[name]!
  flags.remove(modFlag)
  postFlagsChanged(key: modKey, flags: flags, down: false)
}
