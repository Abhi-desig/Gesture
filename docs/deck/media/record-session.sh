#!/bin/bash
# Records both screens for 100 s while you use Mime, for the case study's full
# video. Film yourself with your phone at the same time; the two get synced on
# your first OK sign, which shows on the phone and as "I'm awake" on screen.
#
# Before running:
#   - System Settings > Desktop & Dock: untick "On Desktop" for Show Items
#     and Show Widgets; set a bright wallpaper; close anything private;
#   - on the laptop, open a long web page (for palm up / down to scroll);
#   - on the BenQ, leave one window open (for look + pinch to bring forward);
#   - Mime running, Jelly in the notch, camera off.
# Then, in Terminal:
#   bash docs/deck/media/record-session.sh
#
# The recordings go to ~/Movies, outside the project, so nothing on screen can
# reach a commit by accident.
set -u
LENGTH=100
OUT="$HOME/Movies/mime-session-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"

if ! screencapture -x "$OUT/check.png" 2>/dev/null; then
  echo "macOS blocked the capture. Allow Terminal in System Settings > Privacy & Security >"
  echo "Screen & System Audio Recording, quit and reopen Terminal, then run this again."
  exit 1
fi
rm -f "$OUT/check.png"

echo "Start your phone recording now."
for n in 5 4 3 2 1; do echo "  $n"; sleep 1; done
screencapture -v -V "$LENGTH" -x "$OUT/laptop.mov" &
screencapture -v -V "$LENGTH" -x -D 2 "$OUT/benq.mov" &
echo "Recording both screens for $LENGTH s. Go, a breath between each:"
echo "  1. click the notch                     (Waking up...)"
echo "  2. OK sign, hold 1/2 s                 (I'm awake)"
echo "  3. swipe left, then swipe right        (Hey, I'm looking)"
echo "  4. palm down, then palm up             (Down we go / Up we go)"
echo "  5. look at the BenQ, pinch             (its window comes forward)"
echo "  6. pen in hand, write, swipe left      (no putting the pen down)"
echo "  7. open palm, hold still               (Got it)"
echo "  8. shh, finger on lips                 (Shh)"
echo "  9. OK sign                             (Going to sleep)"
wait
echo "Done. Saved in $OUT:"
ls -la "$OUT"
