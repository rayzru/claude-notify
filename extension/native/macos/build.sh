#!/bin/sh
# Builds the notification helper: a universal (arm64 + x86_64), ad-hoc signed app bundle.
# Needs only the Command Line Tools.
#
#   build.sh <out-dir> <version>
#
# The result is written without the .app suffix on purpose. A bundle named .app inside the
# extension's versioned folder would be registered with LaunchServices, and after an
# update a click could relaunch a stale copy. The extension copies it to a fixed place and
# names it .app there.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
out=$1
version=$2
bundle_id=ru.rayz.notify-for-claude-code

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
app="$work/Notify for Claude Code.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos13" -o "$work/notify-$arch" "$here/main.swift"
done
lipo -create -output "$app/Contents/MacOS/notify" "$work/notify-arm64" "$work/notify-x86_64"

sed "s/__VERSION__/$version/g" "$here/Info.plist" > "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"
cp "$here/AppIcon.icns" "$app/Contents/Resources/AppIcon.icns"

# arm64 code must be signed. The identifier must equal CFBundleIdentifier: permission to
# notify is granted to that identity.
codesign --force --sign - --identifier "$bundle_id" "$app"
codesign --verify --strict "$app"

rm -rf "$out"
mkdir -p "$(dirname "$out")"
cp -R "$app" "$out"
lipo -info "$out/Contents/MacOS/notify"
