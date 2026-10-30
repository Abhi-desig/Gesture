#!/bin/bash
# Captures Mime's notch, and two short screen recordings, for the case study deck.
#
# Run it in Terminal, with the Terminal window on the laptop screen:
#   bash docs/deck/media/capture.sh
#
# It takes about a minute. What happens: Gesture restarts (for the greeting),
# the camera turns on for a few seconds, the laptop screen switches desktop
# once and back, and a Page Down and Page Up go to Terminal. The laptop screen
# needs a second desktop for the switch (Mission Control, then +).
#
# Gestures are fired the way the page's test buttons fire them: the server
# presses the real key, then the page's "fired" event makes Jelly speak.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RAW="$HERE/raw"
API=http://127.0.0.1:4321
NOTCH="240,0,960,240" # top centre of the built-in screen, in points
SEQ=$(( $(date +%s) % 100000 + 900000 ))
mkdir -p "$RAW"

post() { curl -s -m 5 -H 'Content-Type: application/json' -d "$2" "$API$1" >/dev/null; }
said() { # mood, text: the event the page posts after a gesture
  SEQ=$((SEQ + 1))
  post /mascot "{\"mood\":\"$1\",\"gaze\":{\"x\":0,\"y\":0},\"label\":\"$2\",\"event\":{\"seq\":$SEQ,\"type\":\"fired\",\"text\":\"$2\"}}"
}
fire() { post /gesture "{\"gesture\":\"$1\"}"; said nod "$2"; }
burst() { # name, count, seconds apart
  for i in $(seq -w 1 "$2"); do screencapture -x -R"$NOTCH" "$RAW/$1-$i.png"; sleep "$3"; done
}

echo "1/7 Checking screen recording"
if ! screencapture -x -R"$NOTCH" "$RAW/test.png" 2>/dev/null; then
  echo "macOS blocked the capture. Allow Terminal in System Settings > Privacy & Security > Screen Recording,"
  echo "quit and reopen Terminal, then run this again."
  exit 1
fi
rm -f "$RAW/test.png"

echo "2/7 Starting Gesture, for the greeting"
osascript -e 'quit app "Gesture"' 2>/dev/null
sleep 2
open -a Gesture
burst 05a-greeting 24 0.5

echo "3/7 The notch at rest, camera off"
burst 03-rest-off 3 0.5

echo "4/7 Camera on: Waking up"
post /camera '{"on":true}'
burst 05b-waking 20 0.3
sleep 3
burst 03-rest-on 3 0.5

echo "5/7 I'm awake, then Going to sleep"
said awake "OK sign → armed"
burst 05c-awake 8 0.25
sleep 2
said asleep "OK sign → disarmed"
burst 05d-sleep 8 0.25
sleep 2

echo "6/7 Recording a desktop switch"
screencapture -v -V 7 -x "$RAW/13-desktop.mov" &
sleep 1.5
fire swipe_left "Swipe left → next desktop"
wait
sleep 1
post /gesture '{"gesture":"swipe_right"}'
sleep 2

echo "7/7 Recording the spring: two gestures in a row"
screencapture -v -V 6 -x "$RAW/16-springs.mov" &
sleep 1.5
fire swipe_up "Swipe up → page down"
sleep 0.7
fire swipe_down "Swipe down → page up"
wait

post /camera '{"on":false}'
echo "Done. $(ls "$RAW" | wc -l | tr -d ' ') files in $RAW"
