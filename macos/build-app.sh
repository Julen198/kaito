#!/usr/bin/env bash
# Compila Kaito.app (universal arm64 + x86_64), lo firma ad hoc y lo empaqueta en build/Kaito-macOS.zip.
#   ./build-app.sh            universal (necesita Xcode)
#   ./build-app.sh --native   solo la arquitectura de esta máquina (más rápido, para probar)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
VERSION="$(tr -d '[:space:]' < ../VERSION)"
BUNDLE_ID="io.github.julen198.kaito"
OUT="$HERE/build"
APP="$OUT/Kaito.app"

ARCHS=(--arch arm64 --arch x86_64)
[ "${1:-}" = "--native" ] && ARCHS=()

echo "==> swift build -c release ${ARCHS[*]:-} (Kaito $VERSION)"
swift build -c release --product KaitoApp ${ARCHS[@]+"${ARCHS[@]}"}
BIN_DIR="$(swift build -c release --product KaitoApp ${ARCHS[@]+"${ARCHS[@]}"} --show-bin-path)"
BIN="$BIN_DIR/KaitoApp"
[ -x "$BIN" ] || { echo "No encuentro el binario en $BIN" >&2; exit 1; }

echo "==> Montando $APP"
rm -rf "$APP" "$OUT/Kaito-macOS.zip"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Kaito"
# Icono: Resources/Kaito.icns (generado con Resources/make-icon.py); si falta, desde el PNG de 1024 con sips + iconutil.
if [ -f "$HERE/Resources/Kaito.icns" ]; then
  cp "$HERE/Resources/Kaito.icns" "$APP/Contents/Resources/"
elif [ -f "$HERE/Resources/Kaito-1024.png" ] && command -v iconutil >/dev/null; then
  ICONSET="$OUT/Kaito.iconset"
  rm -rf "$ICONSET" && mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$HERE/Resources/Kaito-1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2))
    sips -z "$d" "$d" "$HERE/Resources/Kaito-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Kaito.icns"
  rm -rf "$ICONSET"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>Kaito</string>
    <key>CFBundleDisplayName</key><string>Kaito</string>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleExecutable</key><string>Kaito</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>$VERSION</string>
    <key>CFBundleVersion</key><string>$VERSION</string>
    <key>CFBundleIconFile</key><string>Kaito</string>
    <key>CFBundleDevelopmentRegion</key><string>es</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>LSUIElement</key><true/>
    <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSAppleEventsUsageDescription</key><string>Kaito usa Terminal o iTerm2 para llevarte a la pestaña de cada agente y para abrir Claude con un ticket de Jira.</string>
    <key>NSHumanReadableCopyright</key><string>Kaito</string>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist" >/dev/null 2>&1 || echo "  (plutil no disponible: Info.plist sin validar)"

echo "==> Firma ad hoc"
codesign --force --deep -s - "$APP"
codesign --verify --verbose "$APP" || true
lipo -info "$APP/Contents/MacOS/Kaito" || true

echo "==> Empaquetando"
(cd "$OUT" && ditto -c -k --sequesterRsrc --keepParent Kaito.app Kaito-macOS.zip)
echo "Listo: $OUT/Kaito-macOS.zip"
