#!/usr/bin/env bash
# Instalador de Kaito para macOS (también actualiza).
#   curl -fsSL https://raw.githubusercontent.com/Julen198/kaito/main/macos/install-mac.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/Julen198/kaito/main/macos/install-mac.sh | bash -s -- --update
# Descarga Kaito-macOS.zip de la última GitHub Release, lo instala en ~/Applications, quita la cuarentena,
# instala los hooks de Claude Code (hooks/merge-settings.py, igual que en Linux) y abre la app.
set -euo pipefail

REPO="${KAITO_GH_REPO:-Julen198/kaito}"
API="https://api.github.com/repos/$REPO/releases"
APP_DIR="${KAITO_APP_DIR:-$HOME/Applications}"
APP="$APP_DIR/Kaito.app"
# Código de la release (hooks/): ruta sin espacios porque va en los comandos de ~/.claude/settings.json.
SRC="${KAITO_SRC:-$HOME/.local/share/kaito-src}"
SETTINGS="$HOME/.claude/settings.json"
BIN_DIR="$HOME/.local/bin"

UPDATE=0; YES=0; HOOKS=1; TAG=""; ZIP=""; OPEN=1

usage() {
  cat <<USO
Uso: install-mac.sh [opciones]
  --update          actualiza (cierra Kaito, sustituye la app y la vuelve a abrir)
  -y, --yes         no pregunta (acepta los hooks)
  --no-hooks        no toca ~/.claude/settings.json
  --version vX.Y.Z  instala esa versión en vez de la última
  --zip RUTA        instala un Kaito-macOS.zip local (pruebas)
  --no-open         no abre la app al terminar
  -h, --help        esta ayuda
USO
}

while [ $# -gt 0 ]; do
  case "$1" in
    --update) UPDATE=1 ;;
    -y|--yes) YES=1 ;;
    --no-hooks) HOOKS=0 ;;
    --version) TAG="${2:-}"; shift ;;
    --zip) ZIP="${2:-}"; shift ;;
    --no-open) OPEN=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Opción desconocida: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }
die()  { fail "$*"; exit 1; }

# ask "pregunta" default(y|n) -> 0 si sí (como install.sh de Linux)
ask() {
  local q="$1" def="$2" hint ans
  [ "$def" = y ] && hint="[S/n]" || hint="[s/N]"
  if [ "$YES" = 1 ]; then [ "$def" = y ]; return; fi
  if ! { : </dev/tty; } 2>/dev/null; then warn "Sin terminal interactivo: se asume 'no' (usa --yes)."; return 1; fi
  read -r -p "  $q $hint " ans </dev/tty || return 1
  case "${ans:-}" in "") [ "$def" = y ] ;; [sSyY]*) return 0 ;; *) return 1 ;; esac
}

[ "$(uname -s)" = Darwin ] || die "Este instalador es para macOS. En Linux usa bootstrap.sh."
major="$(sw_vers -productVersion | cut -d. -f1)"
[ "${major:-0}" -ge 14 ] || die "Kaito para macOS necesita macOS 14 (Sonoma) o posterior; tienes $(sw_vers -productVersion)."
command -v curl >/dev/null || die "Falta curl."

TMP="$(mktemp -d -t kaito)"
trap 'rm -rf "$TMP"' EXIT

# Campo de un JSON de la API con python3 (si está) o con sed (suficiente para tag_name/urls).
json_field() { # json_field FICHERO CLAVE
  if /usr/bin/python3 -c 'import sys' >/dev/null 2>&1; then
    /usr/bin/python3 - "$1" "$2" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
k = sys.argv[2]
if k == "asset":
    print(next((a["browser_download_url"] for a in d.get("assets", []) if a.get("name") == "Kaito-macOS.zip"), ""))
else:
    print(d.get(k) or "")
PY
  else
    if [ "$2" = asset ]; then
      grep -o '"browser_download_url": *"[^"]*Kaito-macOS\.zip"' "$1" | head -n1 | sed 's/.*"\(http[^"]*\)"/\1/'
    else
      grep -o "\"$2\": *\"[^\"]*\"" "$1" | head -n1 | sed 's/.*: *"\([^"]*\)"/\1/'
    fi
  fi
}

# ------------------------------------------------------------------ release
if [ -n "$ZIP" ]; then
  [ -f "$ZIP" ] || die "No existe $ZIP"
  cp "$ZIP" "$TMP/Kaito-macOS.zip"
  TAG="${TAG:-local}"
  TARBALL=""
else
  info "Buscando la versión ${TAG:-más reciente} en github.com/$REPO"
  if [ -n "$TAG" ]; then url="$API/tags/$TAG"; else url="$API/latest"; fi
  curl -fsSL -H "Accept: application/vnd.github+json" "$url" -o "$TMP/release.json" \
    || die "No se pudo consultar $url (¿sin red o límite de la API de GitHub? Prueba en un rato)."
  TAG="$(json_field "$TMP/release.json" tag_name)"
  ASSET="$(json_field "$TMP/release.json" asset)"
  TARBALL="$(json_field "$TMP/release.json" tarball_url)"
  [ -n "$TAG" ] || die "Respuesta inesperada de GitHub."
  [ -n "$ASSET" ] || die "La release $TAG no trae Kaito-macOS.zip (aún se está compilando o no es para macOS)."
  ok "Kaito $TAG"
  if [ -d "$APP" ]; then
    cur="$(/usr/bin/defaults read "$APP/Contents/Info" CFBundleShortVersionString 2>/dev/null || true)"
    [ -n "$cur" ] && ok "Instalada: $cur"
  fi
  info "Descargando Kaito-macOS.zip"
  curl -fL --progress-bar "$ASSET" -o "$TMP/Kaito-macOS.zip" || die "Falló la descarga."
fi

# -------------------------------------------------------------------- app
info "Instalando en $APP"
mkdir -p "$TMP/app"
ditto -x -k "$TMP/Kaito-macOS.zip" "$TMP/app" || die "Zip dañado."
[ -d "$TMP/app/Kaito.app" ] || die "El zip no contiene Kaito.app."
if pgrep -x Kaito >/dev/null 2>&1; then
  osascript -e 'tell application id "io.github.julen198.kaito" to quit' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -x Kaito >/dev/null 2>&1 || break; sleep 0.5; done
  pkill -x Kaito 2>/dev/null || true
  ok "Kaito cerrado"
fi
mkdir -p "$APP_DIR"
rm -rf "$APP"
ditto "$TMP/app/Kaito.app" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || warn "No se pudo quitar la cuarentena: la primera vez abre Kaito con clic derecho > Abrir."
ok "$APP"

# ------------------------------------------------------- hooks (código fuente)
if [ -n "${TARBALL:-}" ]; then
  info "Descargando los hooks de Claude Code ($TAG) en $SRC"
  mkdir -p "$TMP/src"
  if curl -fsSL "$TARBALL" -o "$TMP/src.tar.gz" && tar -xzf "$TMP/src.tar.gz" -C "$TMP/src"; then
    top="$(find "$TMP/src" -mindepth 1 -maxdepth 1 -type d | head -n1)"
    if [ -d "$SRC/.git" ]; then
      warn "$SRC es un checkout de git: no se sustituye (actualízalo con git pull)."
    elif [ -n "$top" ] && [ -f "$top/hooks/kaito-hook.py" ]; then
      mkdir -p "$(dirname "$SRC")"
      rm -rf "$SRC.new"; mv "$top" "$SRC.new"
      rm -rf "$SRC"; mv "$SRC.new" "$SRC"
      chmod +x "$SRC"/hooks/*.py "$SRC/macos/install-mac.sh" 2>/dev/null || true
      ok "$SRC"
    else
      warn "El código de la release no trae hooks/; se omiten."
    fi
  else
    warn "No se pudo descargar el código de la release; se omiten los hooks."
  fi
fi

if [ "$HOOKS" = 1 ] && [ -f "$SRC/hooks/merge-settings.py" ]; then
  info "Hooks de Claude Code en $SETTINGS"
  if ! /usr/bin/python3 -c 'import sys' >/dev/null 2>&1; then
    warn "python3 no disponible (instala las Command Line Tools: xcode-select --install). Sin hooks no se ve «te necesita»/«terminó»."
  else
    rc=0
    /usr/bin/python3 "$SRC/hooks/merge-settings.py" install --settings "$SETTINGS" || rc=$?
    if [ "$rc" = 1 ]; then warn "No se pudo preparar la fusión de hooks."
    elif [ "$rc" = 10 ]; then ok "Hooks ya instalados."
    elif ask "¿Aplicar estos cambios en $SETTINGS (se hace copia de seguridad)?" y; then
      /usr/bin/python3 "$SRC/hooks/merge-settings.py" install --settings "$SETTINGS" --apply >/dev/null
      ok "Hooks instalados (copia: $SETTINGS.bak-kaito-*). Se activan en las sesiones de claude nuevas."
    else
      warn "Hooks omitidos. Repite con: bash \"$SRC/macos/install-mac.sh\" --update"
    fi
  fi
elif [ "$HOOKS" = 0 ]; then
  info "Hooks omitidos (--no-hooks)"
fi

# ------------------------------------------------------------ comando kaito
if [ -f "$SRC/macos/install-mac.sh" ]; then
  mkdir -p "$BIN_DIR"
  if [ -e "$BIN_DIR/kaito" ] && ! grep -q 'kaito-mac-cli' "$BIN_DIR/kaito" 2>/dev/null; then
    warn "$BIN_DIR/kaito ya existe y no es de Kaito para macOS: no se toca."
  else
    cat > "$BIN_DIR/kaito" <<'CLI'
#!/usr/bin/env bash
# kaito-mac-cli: update | version | uninstall
set -euo pipefail
SRC="${KAITO_SRC:-$HOME/.local/share/kaito-src}"
APP="${KAITO_APP_DIR:-$HOME/Applications}/Kaito.app"
case "${1:-help}" in
  update) shift; exec curl -fsSL https://raw.githubusercontent.com/Julen198/kaito/main/macos/install-mac.sh | bash -s -- --update "$@" ;;
  version) /usr/bin/defaults read "$APP/Contents/Info" CFBundleShortVersionString ;;
  uninstall)
    osascript -e 'tell application id "io.github.julen198.kaito" to quit' >/dev/null 2>&1 || true
    [ -f "$SRC/hooks/merge-settings.py" ] && /usr/bin/python3 "$SRC/hooks/merge-settings.py" uninstall --apply || true
    rm -rf "$APP" "$SRC"
    echo "Kaito desinstalado (se conservan ~/.config/kaito y ~/.cache/kaito)." ;;
  *) echo "Uso: kaito update [--yes] | version | uninstall" ;;
esac
CLI
    chmod +x "$BIN_DIR/kaito"
    ok "Comando: $BIN_DIR/kaito (update, version, uninstall)"
    case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "$BIN_DIR no está en tu PATH (zsh: echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc)";; esac
  fi
fi

# ------------------------------------------------------------------- final
echo
ok "Kaito $TAG instalado."
if [ "$UPDATE" = 0 ]; then
  cat <<FIN
  Siguientes pasos:
   1. Clic en el icono de Kaito en la barra de menús > engranaje (Ajustes) > Jira:
      URL (https://tuempresa.atlassian.net), email y API token
      (https://id.atlassian.com/manage-profile/security/api-tokens).
   2. La primera vez que vayas a la terminal de un agente o mandes un ticket a Claude, macOS pedirá
      permiso para controlar Terminal/iTerm2 (Automatización): acéptalo.
   3. Captura rápida: ⌃⌥Espacio (cámbialo en Ajustes si choca con el cambio de distribución de teclado).
FIN
fi
if [ "$OPEN" = 1 ]; then
  open "$APP" && ok "Kaito abierto"
fi
