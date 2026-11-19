#!/usr/bin/env bash
# Instalador de Kaito (extensión de GNOME Shell). Idempotente.
set -euo pipefail

UUID="kaito@runnea"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DST="$HOME/.local/share/gnome-shell/extensions/$UUID"
SETTINGS="$HOME/.claude/settings.json"
MERGE="$SRC/hooks/merge-settings.py"

COPY=0; YES=0; DRY=0; HOOKS=1; STATUS=ask

usage() {
  cat <<USO
Uso: ./install.sh [opciones]
  --copy            copia la carpeta en vez de enlazarla (no se actualiza con git pull)
  -y, --yes         no pregunta (acepta los hooks; la statusLine solo con --statusline)
  --no-hooks        no toca ~/.claude/settings.json
  --statusline      añade también la statusLine de Claude Code (si no tienes otra)
  --no-statusline   no ofrece la statusLine
  --dry-run         muestra lo que haría sin cambiar nada
  -h, --help        esta ayuda
USO
}

for a in "$@"; do
  case "$a" in
    --copy) COPY=1 ;;
    -y|--yes) YES=1 ;;
    --dry-run) DRY=1 ;;
    --no-hooks) HOOKS=0 ;;
    --statusline) STATUS=yes ;;
    --no-statusline) STATUS=no ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Opción desconocida: $a" >&2; usage >&2; exit 2 ;;
  esac
done

# KAITO_TEST=1 omite gsettings/gnome-extensions (para pruebas con HOME temporal).
TEST="${KAITO_TEST:-0}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }
act()  { if [ "$DRY" = 1 ]; then echo "  [dry-run] $*"; else return 1; fi; }

# ask "pregunta" default(y|n) -> 0 si sí
ask() {
  local q="$1" def="$2" hint ans
  [ "$def" = y ] && hint="[S/n]" || hint="[s/N]"
  if [ "$YES" = 1 ]; then [ "$def" = y ]; return; fi
  if ! { : </dev/tty; } 2>/dev/null; then warn "Sin terminal interactivo: se asume 'no' (usa --yes)."; return 1; fi
  read -r -p "  $q $hint " ans </dev/tty || return 1
  case "${ans:-}" in "") [ "$def" = y ] ;; [sSyY]*) return 0 ;; *) return 1 ;; esac
}

# Terminal que elegiría terminal='auto' (mismo orden que common.js resolveTerminal) y nivel de foco.
# Imprime "nombre|nivel"; vacío si no hay ninguna.
auto_terminal() {
  local v="" pv="" pn=""
  if command -v ptyxis >/dev/null 2>&1; then
    pn="Ptyxis"; v="$(ptyxis --version 2>/dev/null | grep -oE '[0-9]+' | head -n1 || true)"
  elif command -v flatpak >/dev/null 2>&1 && flatpak info app.devsuite.Ptyxis >/dev/null 2>&1; then
    pn="Ptyxis (flatpak)"; v="$(flatpak info app.devsuite.Ptyxis 2>/dev/null | grep -iE '^ *(versión|version):' | grep -oE '[0-9]+' | head -n1 || true)"
  fi
  if [ -n "$pn" ] && [ "${v:-0}" -ge 52 ]; then echo "$pn ${v}|pestaña exacta"
  elif command -v gnome-terminal >/dev/null 2>&1; then echo "GNOME Terminal|pestaña exacta"
  elif command -v warp-terminal >/dev/null 2>&1; then echo "Warp|pestaña nueva en la ventana; volver al agente: solo ventana"
  elif [ -n "$pn" ]; then echo "$pn ${v:-?}|solo ventana (Ptyxis < 52 no exporta PTYXIS_TAB)"
  elif command -v kgx >/dev/null 2>&1; then echo "Consola (kgx)|solo ventana"
  fi
}
# Valor de "terminal" en config.json ('auto' si no está).
configured_terminal() {
  python3 -c 'import json,os,sys
p=os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"),"kaito","config.json")
try: t=json.load(open(p)).get("terminal")
except Exception: t=None
print(t if t in ("auto","ptyxis","gnome-terminal","kgx","warp","warp-window") else "auto")' 2>/dev/null || echo auto
}

[ "$DRY" = 1 ] && info "Modo --dry-run: no se cambia nada."

# ---------------------------------------------------------------- requisitos
info "Comprobando requisitos"
missing=0
need() { if command -v "$1" >/dev/null 2>&1; then ok "$1"; else fail "falta $1 — $2"; missing=1; fi; }
need python3 "instala python3 (dnf install python3 / apt install python3)"
need glib-compile-schemas "dnf install glib2-devel / apt install libglib2.0-bin"
if [ "$TEST" != 1 ]; then
  need gnome-extensions "dnf install gnome-shell / apt install gnome-shell-extension-prefs"
fi
if command -v secret-tool >/dev/null 2>&1; then ok "secret-tool (opcional)"; else
  warn "secret-tool no encontrado (opcional; el token se guarda desde Ajustes con libsecret). dnf install libsecret / apt install libsecret-tools"; fi
if command -v claude >/dev/null 2>&1 || [ -x "$HOME/.local/bin/claude" ]; then ok "claude (opcional)"; else
  warn "claude no encontrado en PATH (opcional; necesario para borradores de Jira y los agentes)"; fi
auto="$(auto_terminal)"
if [ -n "$auto" ]; then ok "terminal 'auto' para mandar tickets a Claude: ${auto%%|*} · volver al agente: ${auto#*|}"
else warn "ninguna terminal compatible (ptyxis, gnome-terminal, kgx o warp): no se podrán mandar tickets a Claude"; fi
if command -v gnome-shell >/dev/null 2>&1; then
  ver="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -n1 || true)"
  if [ "$ver" = 50 ]; then ok "GNOME Shell $ver"; else
    warn "GNOME Shell ${ver:-desconocido}: Kaito declara shell-version [\"50\"]. Con otra versión GNOME la ignorará;"
    warn "  puedes probar añadiendo tu versión a metadata.json (sin garantías)."
  fi
else
  warn "gnome-shell no encontrado; ¿estás en GNOME?"
fi
if [ "$missing" = 1 ]; then fail "Faltan requisitos obligatorios."; exit 1; fi

# ------------------------------------------------------------------- esquema
info "Compilando esquemas de GSettings"
if act "glib-compile-schemas $SRC/schemas"; then :; else
  glib-compile-schemas "$SRC/schemas"; ok "schemas/gschemas.compiled"; fi

# ------------------------------------------------------------- instalar carpeta
info "Instalando la extensión en $DST"
if [ "$(realpath -m "$DST")" = "$(realpath -m "$SRC")" ]; then
  ok "La carpeta ya está en el directorio de extensiones; nada que enlazar."
elif [ "$COPY" = 1 ]; then
  if act "copiar $SRC -> $DST"; then :; else
    mkdir -p "$(dirname "$DST")"
    if [ -L "$DST" ]; then rm -f "$DST"; elif [ -e "$DST" ]; then rm -rf "$DST"; fi
    cp -a "$SRC" "$DST"; rm -rf "$DST/.git"
    ok "Copiado (para actualizar, vuelve a ejecutar ./install.sh --copy)"; fi
else
  if act "enlazar $DST -> $SRC"; then :; else
    mkdir -p "$(dirname "$DST")"
    if [ -e "$DST" ] && [ ! -L "$DST" ]; then
      bak="$DST.bak-kaito-$(date +%Y%m%d-%H%M%S)"; mv "$DST" "$bak"; warn "Había una copia previa; movida a $bak"
    fi
    ln -sfn "$SRC" "$DST"; ok "$DST -> $SRC"; fi
fi

# --------------------------------------------------------------------- hooks
HOOKS_DONE=0
if [ "$HOOKS" = 1 ]; then
  info "Hooks de Claude Code en $SETTINGS"
  chmod +x "$SRC"/hooks/*.py 2>/dev/null || true
  has_status=0
  if [ -f "$SETTINGS" ]; then
    has_status="$(python3 -c '
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: d={}
sl=d.get("statusLine") if isinstance(d,dict) else None
if not sl: print(0)
elif "kaito-statusline.py" in str(sl.get("command","")): print(2)
else: print(1)' "$SETTINGS")"
  fi
  want_status=0
  case "$STATUS" in
    yes) if [ "$has_status" = 1 ]; then
           warn "Ya tienes una statusLine propia: no se sobrescribe. Para usar la de Kaito, llama a"
           warn "  $SRC/hooks/kaito-statusline.py desde tu script (lee el JSON por stdin y reenvía su salida)."
         else want_status=1; fi ;;
    no) ;;
    ask) if [ "$has_status" = 1 ]; then
           warn "Ya tienes una statusLine: no se toca. Si quieres el uso de 5h/7d en Kaito, encadena"
           warn "  $SRC/hooks/kaito-statusline.py desde tu script (lee el JSON por stdin)."
         elif [ "$has_status" = 0 ] && [ "$DRY" = 0 ] && ask "¿Añadir la statusLine de Kaito (muestra el uso de Claude en la barra)?" n; then want_status=1; fi ;;
  esac
  sargs=(); [ "$want_status" = 1 ] && sargs=(--statusline)
  rc=0
  python3 "$MERGE" install --settings "$SETTINGS" ${sargs[@]+"${sargs[@]}"} || rc=$?
  if [ "$rc" = 1 ]; then fail "No se pudo preparar la fusión de hooks."; exit 1
  elif [ "$rc" = 10 ]; then ok "Hooks ya instalados."
  elif [ "$DRY" = 1 ]; then echo "  [dry-run] se aplicarían los cambios anteriores"
  elif ask "¿Aplicar estos cambios en $SETTINGS (se hace copia de seguridad)?" y; then
    python3 "$MERGE" install --settings "$SETTINGS" ${sargs[@]+"${sargs[@]}"} --apply >/dev/null
    HOOKS_DONE=1; ok "Hooks instalados (copia: $SETTINGS.bak-kaito-*)"
  else warn "Hooks omitidos. Puedes repetirlo más tarde con ./install.sh"; fi
else
  info "Hooks omitidos (--no-hooks)"
fi

# --------------------------------------------------------------- habilitar
info "Habilitando la extensión"
if [ "$TEST" = 1 ]; then warn "KAITO_TEST=1: se omite gnome-extensions/gsettings."
elif act "gnome-extensions enable $UUID (o gsettings enabled-extensions)"; then :; else
  if gnome-extensions enable "$UUID" 2>/dev/null; then ok "Habilitada con gnome-extensions"
  else
    warn "El shell aún no conoce la extensión (normal en Wayland); se registra vía gsettings."
    python3 - "$UUID" <<'PY'
import ast, subprocess, sys
uuid = sys.argv[1]
def gs(*a):
    return subprocess.run(["gsettings", *a], capture_output=True, text=True, check=True).stdout.strip()
raw = gs("get", "org.gnome.shell", "enabled-extensions")
if raw.startswith("@as"): raw = raw[3:].strip()
lst = ast.literal_eval(raw)
if uuid not in lst:
    lst.append(uuid)
    subprocess.run(["gsettings", "set", "org.gnome.shell", "enabled-extensions", str(lst)], check=True)
    print("  añadida a enabled-extensions")
else:
    print("  ya estaba en enabled-extensions")
if gs("get", "org.gnome.shell", "disable-user-extensions") == "true":
    subprocess.run(["gsettings", "set", "org.gnome.shell", "disable-user-extensions", "false"], check=True)
    print("  disable-user-extensions -> false")
PY
  fi
fi

# --------------------------------------------------------------------- final
echo
info "Listo. Siguientes pasos"
cat <<FIN
  1. Primera instalación: cierra sesión y vuelve a entrar (Wayland no carga extensiones nuevas en caliente).
     Si ya la tenías, el código se recarga solo con 'kaito reload' (lo hace 'kaito update').
  2. Abre el indicador de Kaito en la barra superior > Ajustes y rellena:
       - URL de Jira (https://tuempresa.atlassian.net)
       - tu email de Atlassian
       - API token: https://id.atlassian.com/manage-profile/security/api-tokens
  3. Los agentes de Claude Code aparecerán al iniciar sesiones nuevas (los hooks se leen al arrancar claude).
  Si no aparece: journalctl --user -b | grep -i kaito
FIN
[ "$DRY" = 1 ] && echo "  (dry-run: no se ha cambiado nada)"
exit 0
