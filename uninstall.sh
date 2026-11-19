#!/usr/bin/env bash
# Desinstalador de Kaito. Idempotente.
set -euo pipefail

UUID="kaito@runnea"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DST="$HOME/.local/share/gnome-shell/extensions/$UUID"
SETTINGS="$HOME/.claude/settings.json"
MERGE="$SRC/hooks/merge-settings.py"
YES=0; DRY=0; PURGE=0; HOOKS=1

usage() {
  cat <<USO
Uso: ./uninstall.sh [opciones]
  -y, --yes     no pregunta
  --no-hooks    no toca ~/.claude/settings.json
  --purge       borra también ~/.config/kaito y ~/.cache/kaito (config, pendientes, notas)
  --dry-run     muestra lo que haría sin cambiar nada
  -h, --help    esta ayuda
USO
}
for a in "$@"; do
  case "$a" in
    -y|--yes) YES=1 ;; --dry-run) DRY=1 ;; --purge) PURGE=1 ;; --no-hooks) HOOKS=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Opción desconocida: $a" >&2; usage >&2; exit 2 ;;
  esac
done
TEST="${KAITO_TEST:-0}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
act()  { if [ "$DRY" = 1 ]; then echo "  [dry-run] $*"; else return 1; fi; }
ask() {
  local q="$1" ans
  if [ "$YES" = 1 ]; then return 0; fi
  if ! { : </dev/tty; } 2>/dev/null; then warn "Sin terminal interactivo: se asume 'no' (usa --yes)."; return 1; fi
  read -r -p "  $q [s/N] " ans </dev/tty || return 1
  case "${ans:-}" in [sSyY]*) return 0 ;; *) return 1 ;; esac
}

[ "$DRY" = 1 ] && info "Modo --dry-run: no se cambia nada."

info "Deshabilitando la extensión"
if [ "$TEST" = 1 ]; then warn "KAITO_TEST=1: se omite gnome-extensions/gsettings."
elif act "gnome-extensions disable $UUID y quitarla de enabled-extensions"; then :; else
  command -v gnome-extensions >/dev/null 2>&1 && gnome-extensions disable "$UUID" 2>/dev/null || true
  if command -v gsettings >/dev/null 2>&1; then
    python3 - "$UUID" <<'PY' || true
import ast, subprocess, sys
uuid = sys.argv[1]
raw = subprocess.run(["gsettings", "get", "org.gnome.shell", "enabled-extensions"], capture_output=True, text=True, check=True).stdout.strip()
if raw.startswith("@as"): raw = raw[3:].strip()
lst = ast.literal_eval(raw)
if uuid in lst:
    lst.remove(uuid)
    subprocess.run(["gsettings", "set", "org.gnome.shell", "enabled-extensions", str(lst)], check=True)
PY
  fi
  ok "Deshabilitada"
fi

info "Quitando la extensión de $DST"
if [ -L "$DST" ]; then
  if act "rm $DST (enlace)"; then :; else rm -f "$DST"; ok "Enlace borrado (la carpeta del repo no se toca)"; fi
elif [ -d "$DST" ] && [ "$(realpath -m "$DST")" != "$(realpath -m "$SRC")" ]; then
  if act "rm -rf $DST (copia)"; then :; else rm -rf "$DST"; ok "Copia borrada"; fi
elif [ -d "$DST" ]; then
  warn "El repo está instalado directamente en $DST; bórralo a mano si quieres."
else ok "No estaba instalada."; fi

if [ "$HOOKS" = 1 ]; then
  info "Hooks y statusLine de Kaito en $SETTINGS"
  if [ ! -f "$SETTINGS" ]; then ok "No existe settings.json; nada que quitar."; else
    rc=0; python3 "$MERGE" uninstall --settings "$SETTINGS" || rc=$?
    if [ "$rc" = 1 ]; then warn "No se pudo procesar settings.json."
    elif [ "$rc" = 10 ]; then ok "No había entradas de Kaito."
    elif [ "$DRY" = 1 ]; then echo "  [dry-run] se aplicarían los cambios anteriores"
    elif ask "¿Quitar estas entradas de $SETTINGS (con copia de seguridad)?"; then
      python3 "$MERGE" uninstall --settings "$SETTINGS" --apply >/dev/null; ok "Entradas quitadas"
    else warn "settings.json sin tocar."; fi
  fi
fi

CFG="${XDG_CONFIG_HOME:-$HOME/.config}/kaito"; CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/kaito"
if [ "$PURGE" = 1 ]; then
  info "Purgando datos"
  if act "rm -rf $CFG $CACHE"; then :; elif ask "¿Borrar $CFG y $CACHE (config, pendientes, notas)?"; then
    rm -rf "$CFG" "$CACHE"; ok "Datos borrados"; else warn "Datos conservados."; fi
else
  info "Se conservan $CFG y $CACHE (usa --purge para borrarlos)"
fi
echo "  El token de Jira sigue en el llavero; para borrarlo: secret-tool clear service jira"
echo "  Cierra sesión y vuelve a entrar para que GNOME Shell descargue la extensión."
