#!/bin/sh
# Renders icon.svg into AppIcon.icns (the helper's icon) and ../../media/icon.png (the
# Marketplace icon). Needs Google Chrome for the rendering; sips and iconutil ship with macOS.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

printf '<!doctype html><style>html,body{margin:0;background:transparent}</style><img src="file://%s" width="1024" height="1024">' "$here/icon.svg" > "$work/icon.html"
"$chrome" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
  --window-size=1024,1024 --screenshot="$work/icon-1024.png" "file://$work/icon.html" 2>/dev/null

set_dir="$work/AppIcon.iconset"
mkdir "$set_dir"
for size in 16 32 128 256 512; do
  sips -z $size $size "$work/icon-1024.png" --out "$set_dir/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double "$work/icon-1024.png" --out "$set_dir/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$set_dir" -o "$here/AppIcon.icns"
sips -z 256 256 "$work/icon-1024.png" --out "$here/../../media/icon.png" >/dev/null
echo "wrote AppIcon.icns and media/icon.png"
