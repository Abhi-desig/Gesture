#!/bin/zsh
#
# One-key launch: start the server if it isn't running, wait until it actually
# serves, and open the page in Chrome with the camera already live.
#
# Bound to a key through Shortcuts.app (Run Shell Script -> Add Keyboard
# Shortcut). That matters for how this is written: Shortcuts runs it with
# launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), detached from any terminal,
# with stdout and stderr thrown away. So node is located by absolute path rather
# than found on PATH, and anything fatal is said out loud in a notification
# instead of printed to a stderr nobody is reading.
#
# This deliberately duplicates the attach-or-spawn logic in
# src-tauri/src/lib.rs rather than shelling out to Gesture.app: the point of a
# script is that it works from a cold machine with nothing running, and without
# an app rebuild — which is unsigned, and so costs the Accessibility grant.

set -u

ROOT="${0:A:h:h}"
LOG="$HOME/Library/Logs/gesture-server.log"

# Say it where it will be seen. Shortcuts discards stderr, so a failure that
# only printed would look exactly like a key that does nothing.
die() {
  print -r -- "gesture-launch: $1" >&2
  print -r -- "$(date '+%Y-%m-%dT%H:%M:%S') gesture-launch: $1" >>"$LOG" 2>/dev/null
  osascript -e "display notification \"$1\" with title \"Gesture\"" >/dev/null 2>&1
  exit 1
}

cd "$ROOT" || die "could not enter $ROOT"
[[ -f server/index.js ]] || die "no server/index.js in $ROOT"

# ------------------------------------------------------------------ node

# Homebrew installs outside launchd's PATH, and GUI-launched processes inherit
# launchd's PATH — so a bare `node` works from a terminal and silently fails
# from a hotkey. Same candidate list as find_node() in src-tauri/src/lib.rs.
find_node() {
  if [[ -n "${GESTURE_NODE:-}" && -x "$GESTURE_NODE" ]]; then
    print -r -- "$GESTURE_NODE"
    return 0
  fi
  local candidate
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [[ -x "$candidate" ]] && { print -r -- "$candidate"; return 0; }
  done
  candidate="$(command -v node 2>/dev/null)" && [[ -n "$candidate" ]] && {
    print -r -- "$candidate"
    return 0
  }
  return 1
}

NODE="$(find_node)" || die "no node binary found — set GESTURE_NODE to its path"

# ------------------------------------------------------------------ port

# config.json is user-editable, so read the port rather than assuming 4321.
PORT="$("$NODE" -e 'process.stdout.write(String(require("./config.json").port ?? 4321))' 2>/dev/null)"
[[ "$PORT" == <-> ]] || PORT=4321
URL="http://127.0.0.1:$PORT"

server_is_up() {
  curl -fsS -m 1 "$URL/health" >/dev/null 2>&1
}

# ------------------------------------------------------------------ server

if server_is_up; then
  print -r -- "gesture-launch: attaching to the server already on $URL"
else
  mkdir -p "$(dirname "$LOG")" 2>/dev/null
  print -r -- "--- $(date '+%Y-%m-%dT%H:%M:%S') gesture-launch: starting $NODE server/index.js" >>"$LOG"

  # Detached on purpose, and *without* GESTURE_PARENT_PID. The watchdog in
  # server/index.js exits when its parent dies, which is right for the long-lived
  # menu-bar app and exactly wrong here: this script returns in under a second,
  # and the server would die with it.
  nohup "$NODE" server/index.js >>"$LOG" 2>&1 &
  disown

  # Same 15s budget as wait_for_server() in src-tauri/src/lib.rs.
  for _ in {1..75}; do
    server_is_up && break
    sleep 0.2
  done

  server_is_up || die "the server did not come up on $URL — see $LOG"
fi

# ------------------------------------------------------------------ chrome

# The page posts a heartbeat every 2s. One in the last few seconds means a live
# client already exists, so focus its window instead of stacking another: `open
# -na` opens a *new* app window every time, and a hotkey pressed twice should
# not leave two cameras running. Fails open — any trouble here just opens
# normally, which is the behaviour we had before this check existed.
page_is_live() {
  local recent
  recent="$(curl -fsS -m 1 "$URL/recent" 2>/dev/null)" || return 1
  "$NODE" -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        const { events } = JSON.parse(raw);
        const fresh = events.some(
          (e) => e.type === "heartbeat" && Date.now() - Date.parse(e.t) < 6000,
        );
        process.exit(fresh ? 0 : 1);
      } catch {
        process.exit(1);
      }
    });
  ' <<<"$recent" 2>/dev/null
}

if page_is_live; then
  print -r -- "gesture-launch: a page is already running — focusing Chrome"
  open -a "Google Chrome" 2>/dev/null && exit 0
fi

# Chrome specifically, not the default browser: it is the only engine here with
# MediaStreamTrackProcessor, which is what lets detection keep running while the
# window is hidden. ?camera=1 is the page's opt-in autostart — camera on, still
# disarmed.
if ! open -na "Google Chrome" --args --app="$URL/?camera=1" 2>/dev/null; then
  print -r -- "gesture-launch: could not open Google Chrome — falling back to the default browser." >&2
  print -r -- "gesture-launch: detection only continues while the window is visible outside Chrome." >&2
  open "$URL/?camera=1" || die "could not open a browser at $URL"
fi
