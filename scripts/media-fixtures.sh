#!/usr/bin/env bash
# Makes the media fixtures scripts/media-check.mjs needs (WebM VP9/Opus, plus a VP9-in-MP4 "smaller copy" and JPEGs) with ffmpeg.
#   bash scripts/media-fixtures.sh <dir>   then   MEDIA_DIR=<dir> CHROMIUM_PATH=... node scripts/media-check.mjs
set -euo pipefail
d="${1:?usage: media-fixtures.sh <dir>}"; mkdir -p "$d"
ff() { ffmpeg -y -loglevel error "$@"; }
# 8 s portrait video with sound; 6 s landscape; a 6 s 1080x1920 "HD" original and its 480p copy (VP9 in MP4; Playwright's Chromium has no H.264)
ff -f lavfi -i "testsrc2=size=540x960:rate=25:duration=8" -f lavfi -i "sine=frequency=440:duration=8" -c:v libvpx-vp9 -b:v 600k -c:a libopus -shortest "$d/portrait.webm"
ff -f lavfi -i "testsrc2=size=960x540:rate=25:duration=6" -f lavfi -i "sine=frequency=520:duration=6" -c:v libvpx-vp9 -b:v 600k -c:a libopus -shortest "$d/landscape.webm"
ff -f lavfi -i "testsrc2=size=1080x1920:rate=25:duration=6" -f lavfi -i "sine=frequency=330:duration=6" -c:v libvpx-vp9 -b:v 2500k -c:a libopus -shortest "$d/tall-hd.webm"
ff -f lavfi -i "testsrc2=size=480x854:rate=25:duration=6" -f lavfi -i "sine=frequency=330:duration=6" -c:v libvpx-vp9 -b:v 300k -c:a libopus -strict -2 -shortest -movflags +faststart "$d/tall-hd-480.mp4"
# a 40 s song (audio only)
ff -f lavfi -i "sine=frequency=262:duration=40" -c:a libopus -b:a 64k "$d/song.webm"
# stills
ff -f lavfi -i "testsrc2=size=540x960:duration=1" -frames:v 1 "$d/poster.jpg"
ff -f lavfi -i "testsrc2=size=1080x1350:duration=1" -frames:v 1 "$d/portrait.jpg"
ff -f lavfi -i "testsrc2=size=1080x608:duration=1" -frames:v 1 "$d/landscape.jpg"
ff -f lavfi -i "testsrc2=size=1080x1080:duration=1" -frames:v 1 "$d/square.jpg"
ff -f lavfi -i "testsrc2=size=1080x1920:duration=1" -frames:v 1 "$d/tall.jpg"
echo "fixtures in $d"
