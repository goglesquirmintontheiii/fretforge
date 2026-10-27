#!/usr/bin/env bash
# Package packages/desktop/release/linux-unpacked as an AppImage using appimagetool's
# static runtime: it needs only fusermount3 (fuse3), which Fedora and Nobara ship by default,
# not the old libfuse2 that type-2 AppImages from electron-builder require.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP="$ROOT/packages/desktop"
UNPACKED="$DESKTOP/release/linux-unpacked"
VERSION="$(node -p "require('$ROOT/package.json').version")"
ARCH="${ARCH:-x86_64}"
OUT="$ROOT/release"
TOOLS="$ROOT/.tools"
APPDIR="$(mktemp -d)/Fretforge.AppDir"

[ -x "$UNPACKED/fretforge" ] || { echo "Run electron-builder --linux --dir first ($UNPACKED missing)"; exit 1; }
mkdir -p "$OUT" "$TOOLS" "$APPDIR/usr/lib/fretforge" "$APPDIR/usr/share/applications" "$APPDIR/usr/share/icons/hicolor/512x512/apps"

APPIMAGETOOL="$TOOLS/appimagetool-$ARCH.AppImage"
if [ ! -x "$APPIMAGETOOL" ]; then
  curl -fsSL -o "$APPIMAGETOOL" "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-$ARCH.AppImage"
  chmod +x "$APPIMAGETOOL"
fi

cp -a "$UNPACKED/." "$APPDIR/usr/lib/fretforge/"
# AppImages are mounted nosuid, so Chromium's setuid helper can never work there. Without it,
# Chromium uses the user-namespace sandbox, which Fedora/Nobara allow; AppRun falls back if not.
rm -f "$APPDIR/usr/lib/fretforge/chrome-sandbox"

cp "$DESKTOP/build/icon.png" "$APPDIR/usr/share/icons/hicolor/512x512/apps/fretforge.png"
cp "$DESKTOP/build/icon.png" "$APPDIR/fretforge.png"
ln -s fretforge.png "$APPDIR/.DirIcon"

cat > "$APPDIR/fretforge.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Fretforge
GenericName=Tab player
Comment=Play, practise and search guitar, bass and drum tabs
Exec=fretforge %F
Icon=fretforge
Terminal=false
Categories=Audio;Music;Education;
Keywords=guitar;tabs;songsterr;bass;drums;practice;
StartupWMClass=Fretforge
X-AppImage-Version=$VERSION
DESKTOP
cp "$APPDIR/fretforge.desktop" "$APPDIR/usr/share/applications/"

cat > "$APPDIR/AppRun" <<'APPRUN'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
FLAGS=""
# Chromium's sandbox needs unprivileged user namespaces inside an AppImage. They're on by default
# on Fedora/Nobara; if they're blocked (or we're root), run without it rather than refuse to start.
# Some distros restrict them (Ubuntu 24.04's AppArmor setting, Debian's userns_clone=0).
no_userns() {
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = "1" ] && return 0
  [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = "0" ] && return 0
  ! unshare --user --map-root-user --pid --fork true >/dev/null 2>&1
}
if [ "$(id -u)" = "0" ] || no_userns; then
  FLAGS="--no-sandbox"
fi
# Native Wayland on KDE/GNOME Wayland sessions; set FRETFORGE_X11=1 to force XWayland.
if [ -n "$WAYLAND_DISPLAY" ] && [ -z "$FRETFORGE_X11" ]; then
  FLAGS="$FLAGS --ozone-platform-hint=auto --enable-features=WaylandWindowDecorations"
fi
exec "$HERE/usr/lib/fretforge/fretforge" $FLAGS $FRETFORGE_FLAGS "$@"
APPRUN
chmod +x "$APPDIR/AppRun"

TARGET="$OUT/Fretforge-$VERSION-$ARCH.AppImage"
rm -f "$TARGET"
ARCH="$ARCH" APPIMAGE_EXTRACT_AND_RUN=1 "$APPIMAGETOOL" --no-appstream "$APPDIR" "$TARGET"
chmod +x "$TARGET"
( cd "$OUT" && sha256sum "$(basename "$TARGET")" > "$(basename "$TARGET").sha256" )
echo "Built $TARGET"
