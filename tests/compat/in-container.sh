#!/bin/bash
# Lo lanza run.sh: dentro del contenedor (SRC=/src, el repo en solo lectura) o en el host (`run.sh host`,
# SRC=el repo). Todo va a XDG temporales y a un bus de sesión propio: nunca toca la sesión real.
# Imprime líneas "RESULT <prueba> PASS|FAIL|SKIP ..." y sale con 1 si alguna falla.
set -u
export SRC=${SRC:-/src}
IN_CONTAINER=; [ -f /run/.containerenv ] && [ "$(id -u)" = 0 ] && IN_CONTAINER=1
W=$(mktemp -d /tmp/kaito-compat-XXXXXX)
trap 'rm -rf "$W"' EXIT
FAIL=0
res() { echo "RESULT $1 $2${3:+ $3}"; [ "$2" = FAIL ] && FAIL=1; return 0; }
fresh() { # XDG temporales nuevos en $1
    rm -rf "$1"; mkdir -p "$1"/{home,config,data,cache,state,run}; chmod 700 "$1/run"
    export HOME=$1/home XDG_CONFIG_HOME=$1/config XDG_DATA_HOME=$1/data XDG_CACHE_HOME=$1/cache \
        XDG_STATE_HOME=$1/state XDG_RUNTIME_DIR=$1/run GSETTINGS_BACKEND=keyfile
}
echo "== $(gnome-shell --version) · gjs $(gjs --version | awk '{print $2}') · $(. /etc/os-release; echo "$PRETTY_NAME")"

# Copia de la extensión (sin .git ni esquemas compilados del host).
EXT=$W/ext
mkdir -p $EXT && cp -a "$SRC"/. $EXT/ && rm -rf $EXT/.git $EXT/schemas/gschemas.compiled
glib-compile-schemas $EXT/schemas || res schemas FAIL

# 1. Tests de GJS (detectan JS que el SpiderMonkey de esta versión no entiende).
for t in kaito.test.js jiradraft.test.js tasks.test.js quiet.test.js providers.test.js board.test.js usage.test.js; do
    fresh $W/t-$t
    out=$(cd $EXT && timeout 120 dbus-run-session -- gjs -m $t 2>&1); rc=$?
    if [ $rc -eq 0 ]; then res "gjs:$t" PASS "$(echo "$out" | grep -E 'OK' | tail -1)"; else res "gjs:$t" FAIL "rc=$rc"; echo "$out" | tail -20; fi
done
if command -v node >/dev/null; then
    for t in when.test.js quiet.test.js providers.test.js board.test.js usage.test.js; do
        (cd $EXT && TZ=Europe/Madrid node $t >/dev/null 2>&1) && res node:$t PASS || res node:$t FAIL
    done
else
    res node:when.test.js SKIP "sin node"
fi

# CLI (kaito check --json con changelog, doctor con proveedores, oferta de notify de Codex) y hooks.
fresh $W/cli
(cd $EXT && timeout 120 bash tests/cli.test.sh >$W/cli.log 2>&1) && res cli.test.sh PASS || { res cli.test.sh FAIL; tail -20 $W/cli.log; }
for h in kaito-hook.py kaito-statusline.py kaito-codex-notify.py; do
    python3 $EXT/hooks/$h --selftest >/dev/null 2>&1 && res hook:$h PASS || res hook:$h FAIL
done
# Iconos simbólicos que usa Kaito (luna de No molestar, cola) en el Adwaita de esta versión.
for i in weather-clear-night-symbolic mail-unread-symbolic preferences-system-notifications-symbolic; do
    find /usr/share/icons/Adwaita -name "$i.*" 2>/dev/null | grep -q . && res icon:$i PASS || res icon:$i FAIL
done

# 2. APIs nativas (typelibs de mutter/gnome-shell de esta versión).
MUT=$(ls -d /usr/lib*/mutter-* /usr/lib/*/mutter-* 2>/dev/null | grep -oE '[0-9]+$' | sort -n | tail -1)
LIBS=$(ls -d /usr/lib*/mutter-$MUT /usr/lib/*/mutter-$MUT /usr/lib*/gnome-shell /usr/lib/*/gnome-shell 2>/dev/null | paste -sd:)
out=$(GI_TYPELIB_PATH=$LIBS LD_LIBRARY_PATH=$LIBS gjs "$SRC"/tests/compat/apicheck.js $MUT 2>&1)
echo "$out" | grep -E '^(MISS|info)'
echo "$out" | grep -q '^APICHECK ok' && res apicheck PASS "mutter-$MUT" || { res apicheck FAIL; echo "$out" | tail -5; }

# 3. gnome-shell headless con Kaito + la autoprueba; prefs.js contra ese mismo compositor.
fresh $W/shell
LOG=$W/shell.log
mkdir -p $XDG_DATA_HOME/gnome-shell/extensions $XDG_CONFIG_HOME/kaito $HOME/Desktop
cp -a $EXT $XDG_DATA_HOME/gnome-shell/extensions/kaito@runnea
cp -a "$SRC"/tests/compat/selftest@kaito $XDG_DATA_HOME/gnome-shell/extensions/
# KAITO_COMPAT_FEATURES=on: arranca con el tablero y el panel de avisos activados (la autoprueba los comprueba y los apaga).
[ "${KAITO_COMPAT_FEATURES:-}" = on ] && echo '{"kanbanEnabled": true, "inboxEnabled": true}' > $XDG_CONFIG_HOME/kaito/config.json && echo "info opcionales activados desde el arranque"
echo '[{"id":"t1","name":"Revisar ventas","key":"RUN-1","cwd":"/tmp","enabled":true,"lastOk":true,"prompt":"x","nextRun":"2099-01-01T09:00:00.000Z"}]' > $XDG_CONFIG_HOME/kaito/tasks.json
# Uso falso (0.5.0, anillos): Claude 42 % / 18 % desde la statusLine y un rollout de Codex de hoy con 78 % / 95 %.
NOW=$(date +%s); mkdir -p $XDG_CACHE_HOME/kaito $HOME/.codex/sessions/$(date +%Y/%m/%d)
echo "{\"ts\": $NOW, \"rate_limits\": {\"five_hour\": {\"used_percentage\": 42, \"resets_at\": $((NOW + 9000))}, \"seven_day\": {\"used_percentage\": 18, \"resets_at\": $((NOW + 4 * 86400))}}}" > $XDG_CACHE_HOME/kaito/claude-usage.json
echo "{\"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\", \"type\": \"event_msg\", \"payload\": {\"type\": \"token_count\", \"rate_limits\": {\"primary\": {\"used_percent\": 78, \"window_minutes\": 300, \"resets_in_seconds\": 3600}, \"secondary\": {\"used_percent\": 95, \"window_minutes\": 10080, \"resets_in_seconds\": 200000}}}}" > $HOME/.codex/sessions/$(date +%Y/%m/%d)/rollout-2026-01-01T00-00-00-00000000-0000-0000-0000-000000000000.jsonl
if [ -n "$IN_CONTAINER" ]; then
    # Sin logind: con /run/systemd/seats gnome-shell cree que hay systemd y muere al no haber bus de sistema.
    rm -rf /run/systemd/seats
    # Bus de sistema vacío: gnome-shell crea proxies síncronos (logind, accounts…) al arrancar.
    mkdir -p /run/dbus && dbus-daemon --system --fork 2>/dev/null || echo "aviso: sin bus de sistema"
fi
# Sin X11: no hay Xwayland en la imagen (y /tmp/.X11-unix no existe).
NOX11=; gnome-shell --help 2>&1 | grep -q -- '--no-x11' && NOX11=--no-x11
# Extras de la sesión de Ubuntu (imagen 50u): dock, appindicator, Yaru y modo `ubuntu` si existen.
EXTRA_EXT=; for u in ubuntu-dock@ubuntu.com ubuntu-appindicators@ubuntu.com; do
    [ -d /usr/share/gnome-shell/extensions/$u ] && EXTRA_EXT="$EXTRA_EXT, \"$u\""
done
MODE=; [ -f /usr/share/gnome-shell/modes/ubuntu.json ] && [ -f /usr/share/gnome-shell/theme/Yaru/gnome-shell-theme.gresource ] && MODE=--mode=ubuntu
[ -n "$EXTRA_EXT" ] && echo "info ubuntu extras:$EXTRA_EXT ${MODE:+(shell $MODE)}"
if command -v ptyxis >/dev/null; then
    cat > $W/term.js <<JS
import {resolveTerminal, terminalFocusLevel, ptyxisVersion} from 'file://$EXT/common.js';
const t = resolveTerminal('auto');
print(t ? t.id + ' -> nivel de foco ' + terminalFocusLevel(t.id, t.id === 'ptyxis' ? ptyxisVersion(t.flatpak) : null) : 'ninguno');
JS
    echo "info terminal: $(ptyxis --version 2>&1 | head -1) ; resolveTerminal(auto) = $(gjs -m $W/term.js 2>&1 | tail -1)"
fi
export SHELL_LOG=$LOG NOX11 MODE EXTRA_EXT EXT_DIR=$XDG_DATA_HOME/gnome-shell/extensions/kaito@runnea
dbus-run-session -- bash -c '
    unset DISPLAY WAYLAND_DISPLAY
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell enabled-extensions "[\"kaito@runnea\", \"selftest@kaito\"$EXTRA_EXT]"
    gnome-shell --wayland $NOX11 $MODE --headless --virtual-monitor 1280x800 > $SHELL_LOG 2>&1 &
    SP=$!
    for i in $(seq 120); do grep -q "SELFTEST done" $SHELL_LOG && break; kill -0 $SP 2>/dev/null || break; sleep 0.5; done
    gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell \
        -m org.gnome.Shell.Extensions.GetExtensionInfo kaito@runnea > $SHELL_LOG.info 2>&1
    for u in ubuntu-dock@ubuntu.com ubuntu-appindicators@ubuntu.com; do
        echo "$u $(gdbus call --session -d org.gnome.Shell -o /org/gnome/Shell -m org.gnome.Shell.Extensions.GetExtensionInfo $u 2>&1 | grep -oE ".(state|error).: <[^>]*>" | tr "\n" " ")" >> $SHELL_LOG.exts
    done
    # prefs del sistema importan Shew (typelib privado de gnome-shell).
    GI_TYPELIB_PATH=$(ls -d /usr/lib*/gnome-shell/girepository-1.0 /usr/lib/*/gnome-shell 2>/dev/null | paste -sd:) \
    LD_LIBRARY_PATH=$(ls -d /usr/lib*/gnome-shell /usr/lib/*/gnome-shell 2>/dev/null | paste -sd:) \
    GTK_A11Y=none WAYLAND_DISPLAY=$(ls $XDG_RUNTIME_DIR | grep -m1 "^wayland-[0-9]*$") timeout 60 \
        gjs -m $SRC/tests/compat/prefs-check.js $EXT_DIR > $SHELL_LOG.prefs 2>&1
    echo "rc=$?" >> $SHELL_LOG.prefs
    kill $SP; wait $SP 2>/dev/null
' 2> $W/dbus.log
state=$(grep -oE "'state': <[0-9.]+>" $LOG.info | grep -oE '[0-9]+' | head -1)
[ "$state" = 1 ] && res shell:state PASS "state=1 (ACTIVE)" || { res shell:state FAIL "state=${state:-?}"; cat $LOG.info; }
grep -q 'kaito: cargado build' $LOG && res shell:load PASS "$(grep -c 'kaito: cargado build' $LOG) builds cargadas" || res shell:load FAIL
grep 'SELFTEST' $LOG | sed 's/^.*SELFTEST/SELFTEST/'
grep -q 'SELFTEST done' $LOG && ! grep -q 'SELFTEST FAIL' $LOG && res selftest PASS || res selftest FAIL
# Errores cuyo mensaje o pila (líneas "func@file:///…:N:M" que le siguen) mencionan a kaito o a la autoprueba.
errs=$(awk '# (El aviso de la papelera de ubuntu-dock es del contenedor, sin gvfs; su pila arrastra la autoprueba.)
    function k(x) { if (x ~ /^[^\n]*Impossible to monitor trash/) return 0; gsub(/kaito-compat/, "", x); return x ~ /kaito|selftest/ }
    /JS ERROR|Unhandled promise|CRITICAL|JS WARNING|Gjs-WARNING/ { if (k(b)) print b; b = $0; next }
    b != "" && /@.*:[0-9]+(:[0-9]+)?$|^Stack trace|^== Stack trace|^#[0-9]+ |^$/ { b = b "\n" $0; next }
    { if (k(b)) print b; b = "" }
    END { if (k(b)) print b }' $LOG)
[ -z "$errs" ] && res shell:errors PASS "0 errores de kaito" || { res shell:errors FAIL; echo "$errs" | head -30; }
[ -n "$EXTRA_EXT" ] && sed "s/^/info ext: /" $LOG.exts
[ -n "${KAITO_SHOT:-}" ] && { [ -s "$KAITO_SHOT" ] && echo "info captura: $KAITO_SHOT" || echo "info captura: no generada"; }
grep -iE 'kaito' $LOG | grep -vE 'SELFTEST|cargado build' | head -20
# El aviso del llavero (no hay org.freedesktop.secrets en el contenedor) es esperado.
if grep -q '^PREFS ok' $LOG.prefs && grep -q 'rc=0' $LOG.prefs && ! grep -qE 'JS ERROR|threw an exception|TypeError|ReferenceError' $LOG.prefs; then
    res prefs PASS "$(grep '^PREFS ok' $LOG.prefs | cut -d' ' -f3-)"; grep -E 'WARNING|CRITICAL' $LOG.prefs | sed 's/^/  (prefs) /'
else
    res prefs FAIL; cat $LOG.prefs | head -30
fi
[ -n "${SHOW_LOG:-}" ] && { echo "----- shell.log"; cat $LOG; }
exit $FAIL
