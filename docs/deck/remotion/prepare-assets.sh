#!/bin/bash
# Copies everything the film uses into public/: your footage trimmed to the
# moments that work (no sound), Jelly's art, the gesture icons, the real notch
# images and the Inter font. Run again if the source files change.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
MEDIA="$HERE/../media"
PUB="$HERE/public"
A="$HOME/Downloads/IMG_4293.MOV"
B="$HOME/Downloads/IMG_4294.MOV"
FF="ffmpeg -loglevel error -y"
ENC="-c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -g 15 -movflags +faststart -an"
mkdir -p "$PUB/footage" "$PUB/jelly" "$PUB/tiles" "$PUB/notch" "$PUB/fonts"

# name, clip, start, length: only the moments the film shows.
cut() { $FF -ss "$3" -t "$4" -i "$2" $ENC "$PUB/footage/$1.mp4"; }
cut writing "$A" 0.5 8.5   # writing in the notebook
cut pen-down "$A" 11.0 6.0 # the pen goes down, the hand goes to the keyboard
cut ok-sign "$A" 18.0 5.0  # the OK sign
cut swipe-fails "$B" 10.0 9.0 # a swipe; the desktop stays; "That didn't work"
cut swipe-works "$B" 19.0 6.0 # a swipe; the desktop moves; "Hey, I'm looking"
cut lock "$B" 37.5 4.3     # the hand rises for the fist; "See you soon"; the Mac locks

cp "$MEDIA"/jelly-reference/*.png "$PUB/jelly/"
cp "$MEDIA"/06-gestures/cap-*.png "$MEDIA"/06-gestures/LICENSE-fluent-emoji.txt "$PUB/tiles/"
cp "$MEDIA"/05-flow/*-mac.png "$PUB/notch/"
cp "$MEDIA"/02-problem/cap-03-notch-at-rest-mac.png "$PUB/notch/"
for w in Regular Medium SemiBold Bold; do cp "$HOME/Library/Fonts/Inter-$w.otf" "$PUB/fonts/"; done
ls -R "$PUB" | head -60
