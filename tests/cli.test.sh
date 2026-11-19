#!/usr/bin/env bash
# Pruebas de la CLI (bin/kaito), del instalador (parte de Codex) y del hook de Codex.
# Todo ocurre en un directorio temporal; no toca tu HOME, tu git ni tu configuración.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
FAILS=0
pass() { printf '  ok   %s\n' "$*"; }
fail() { printf '  FAIL %s\n' "$*" >&2; FAILS=$((FAILS + 1)); }
check() { local d="$1"; shift; if "$@"; then pass "$d"; else fail "$d"; fi; }

export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export KAITO_TEST=1
H="$T/home"; mkdir -p "$H"
export HOME="$H" XDG_CACHE_HOME="$H/.cache" XDG_CONFIG_HOME="$H/.config"

# ------------------------------------------------------------ check --json
echo "check --json"
git init -q --bare -b main "$T/origin.git"
git clone -q "$T/origin.git" "$T/A" 2>/dev/null
mkdir -p "$T/A/bin"
cp "$REPO/bin/kaito" "$T/A/bin/kaito"; chmod +x "$T/A/bin/kaito"
echo 0.1.0 > "$T/A/VERSION"
git -C "$T/A" add -A; git -C "$T/A" commit -qm "inicial"; git -C "$T/A" push -q origin HEAD:main 2>/dev/null
git -C "$T/A" branch -q -u origin/main 2>/dev/null || git -C "$T/A" branch --set-upstream-to=origin/main >/dev/null 2>&1
git clone -q "$T/origin.git" "$T/B" 2>/dev/null
S1='Arregla "comillas" y acentos áé'; S2='Sube a 0.2.0 \ barra'
git -C "$T/B" commit -q --allow-empty -m "$S1"
echo 0.2.0 > "$T/B/VERSION"; git -C "$T/B" add -A; git -C "$T/B" commit -qm "$S2"
git -C "$T/B" push -q origin HEAD:main 2>/dev/null

OUT="$("$T/A/bin/kaito" check --json 2>&1)"
echo "     $OUT"
S1="$S1" S2="$S2" python3 - "$OUT" <<'PY' && pass "JSON válido: behind=2, latest=0.2.0, changes en orden" || fail "JSON de check"
import json, os, sys
d = json.loads(sys.argv[1])
assert d["current"] == "0.1.0" and d["latest"] == "0.2.0" and d["behind"] == 2, d
assert d["changes"] == [os.environ["S2"], os.environ["S1"]], d["changes"]
PY
TXT="$("$T/A/bin/kaito" check 2>&1)"
check "check en texto lista los cambios" grep -q -- '^  - Sube a 0.2.0' <<<"$TXT"
check "check en texto: hay versión nueva" grep -q 'hay versión nueva: 0.2.0' <<<"$TXT"

# ------------------------------------------------------------------ doctor
echo "doctor"
mkdir -p "$H/.local/bin" "$H/.codex"
printf '#!/bin/sh\nexit 0\n' > "$H/.local/bin/codex"; chmod +x "$H/.local/bin/codex"
printf 'model = "x"\n\n[tui]\nnotifications = true\n' > "$H/.codex/config.toml"
D="$(PATH=/usr/bin:/bin "$REPO/bin/kaito" doctor 2>&1)"
check "doctor menciona Codex" grep -q 'Codex' <<<"$D"
check "doctor encuentra codex falso" grep -q "$H/.local/bin/codex" <<<"$D"
check "doctor avisa del notify sin configurar" grep -q 'notify' <<<"$D"
check "doctor sugiere la línea notify" grep -q 'kaito-codex-notify.py' <<<"$D"
check "doctor muestra Agentes detectados" grep -q 'Agentes detectados' <<<"$D"
printf 'notify = ["python3", "/x/kaito-codex-notify.py"]\n[tui]\n' > "$H/.codex/config.toml"
D="$("$REPO/bin/kaito" doctor 2>&1)"
check "doctor reconoce el notify configurado" grep -q 'aviso de Codex al terminar configurado' <<<"$D"

# ------------------------------------------------------- install.sh (Codex)
echo "install.sh (Codex)"
CFG="$H/.codex/config.toml"
printf 'model = "gpt-5"\n# comentario\n\n[tui]\nnotifications = true\n' > "$CFG"
cp "$CFG" "$T/orig.toml"
I="$("$REPO/install.sh" --codex-notify-only --dry-run 2>&1)"
check "dry-run no modifica config.toml" cmp -s "$CFG" "$T/orig.toml"
check "dry-run muestra la línea" grep -q 'notify = \["python3"' <<<"$I"
check "dry-run no crea copias" bash -c '! ls "$1".bak-kaito-* >/dev/null 2>&1' _ "$CFG"
I="$("$REPO/install.sh" --codex-notify-only --yes </dev/null 2>&1)"
check "--yes no acepta (por defecto no)" cmp -s "$CFG" "$T/orig.toml"
I="$("$REPO/install.sh" --codex-notify-only --yes-codex 2>&1)"
check "se crea copia de seguridad" bash -c 'ls "$1".bak-kaito-* >/dev/null 2>&1' _ "$CFG"
BAK="$(ls "$CFG".bak-kaito-* | head -n1)"
check "la copia es idéntica al original" cmp -s "$BAK" "$T/orig.toml"
python3 - "$CFG" "$T/orig.toml" "$REPO" <<'PY' && pass "notify insertado antes de [tui], resto intacto" || fail "inserción TOML"
import json, sys
new, old, repo = (open(sys.argv[1], encoding="utf-8").read(), open(sys.argv[2], encoding="utf-8").read(), sys.argv[3])
line = 'notify = ["python3", %s]\n' % json.dumps(repo + "/hooks/kaito-codex-notify.py")
i = old.index("[tui]")
assert new == old[:i] + line + "\n" + old[i:], repr(new)
assert new.index("notify") < new.index("[tui]")
PY
I="$("$REPO/install.sh" --codex-notify-only --yes-codex 2>&1)"
check "segunda ejecución: ya configurado" grep -q 'ya configurado' <<<"$I"
# sin tabla y sin fichero
printf 'a = 1' > "$CFG"
"$REPO/install.sh" --codex-notify-only --yes-codex >/dev/null 2>&1
python3 - "$CFG" <<'PY' && pass "sin tablas: notify al final con salto de línea" || fail "sin tablas"
import sys
d = open(sys.argv[1]).read()
assert d.startswith("a = 1\nnotify = [") and d.endswith("]\n"), repr(d)
PY
rm -rf "$H/.codex"
"$REPO/install.sh" --codex-notify-only --yes-codex >/dev/null 2>&1
check "sin fichero: se crea con la línea" grep -q '^notify = ' "$CFG"
# notify ajeno: no se toca
printf 'notify = ["foo"]\n[tui]\n' > "$CFG"; cp "$CFG" "$T/orig2.toml"
I="$("$REPO/install.sh" --codex-notify-only --yes-codex 2>&1)"
check "notify ajeno: no se toca" cmp -s "$CFG" "$T/orig2.toml"
check "notify ajeno: avisa" grep -q 'Ya tienes un programa notify' <<<"$I"
# un 'notify' dentro de una tabla no cuenta como de primer nivel
printf '[tui]\nnotify = 1\n' > "$CFG"
"$REPO/install.sh" --codex-notify-only --yes-codex >/dev/null 2>&1
check "notify dentro de tabla no cuenta" bash -c 'head -n1 "$1" | grep -q "^notify = \[\"python3\""' _ "$CFG"

# ------------------------------------------------------------------- hook
echo "kaito-codex-notify.py"
check "selftest del hook" bash -c 'python3 "$1" --selftest 2>/dev/null | grep -q "selftest OK"' _ "$REPO/hooks/kaito-codex-notify.py"
OUT="$(python3 "$REPO/hooks/kaito-codex-notify.py" '{"type":"agent-turn-complete","thread-id":"abc123","cwd":"/x"}' 2>&1)"
check "el hook no imprime nada" test -z "$OUT"
check "el hook escribe el estado" test -f "$XDG_CACHE_HOME/kaito/state/codex-abc123.json"

if [ "$FAILS" -gt 0 ]; then echo "cli.test.sh: $FAILS fallo(s)" >&2; exit 1; fi
echo "cli.test.sh: OK"
