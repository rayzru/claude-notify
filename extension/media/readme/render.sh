#!/bin/sh
# Renders the README images from the HTML replicas in src/. Needs Google Chrome.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
shot() { # name width height
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --window-size="$2,$3" --virtual-time-budget=3000 --screenshot="$here/$1.png" "file://$here/src/$1.html" 2>/dev/null
}
shot notification 500 220
shot toast 498 150
shot statusbar 640 90
shot sessions 700 400
node "$here/donate/make-html.mjs" >/dev/null
shot donate 870 330
echo "rendered into $here"
