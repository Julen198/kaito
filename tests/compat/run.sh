#!/bin/bash
# Prueba Kaito en GNOME Shell 46/48/49 dentro de contenedores (podman sin root).
# Uso: tests/compat/run.sh <46|48|49|50u|all|host> [--keep-images]
#   46 = Ubuntu 24.04 · 48 = Debian 13 (trixie) · 49 = Ubuntu 25.10 · 50u = Ubuntu 26.04 LTS (GNOME 50 con
#   ubuntu-dock, appindicator, tema Yaru y Ptyxis; arranca el shell en modo ubuntu si existe).
#   host = las mismas pruebas con el gnome-shell del host (p. ej. GNOME 50 en Fedora 44), anidado y headless.
# Construye localhost/kaito-compat:<v> si no existe, monta el repo en solo lectura y ejecuta
# in-container.sh (tests de GJS, gnome-shell headless + autoprueba, prefs). Nunca toca tu sesión.
# UBUNTU_MIRROR=http://…/ubuntu/ cambia la réplica de Ubuntu al construir.
# Las imágenes ocupan ~1-1.5 GB cada una; se borran al final salvo con --keep-images.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
declare -A BASE=([46]=docker.io/library/ubuntu:24.04 [48]=docker.io/library/debian:trixie [49]=docker.io/library/ubuntu:25.10 [50u]=docker.io/library/ubuntu:26.04)
KEEP=0; VERS=()
for a in "$@"; do
    case $a in
        --keep-images) KEEP=1 ;;
        all) VERS=(46 48 49 50u) ;;
        46|48|49|50u|host) VERS+=("$a") ;;
        *) echo "uso: $0 <46|48|49|50u|all|host> [--keep-images]" >&2; exit 2 ;;
    esac
done
[ ${#VERS[@]} -gt 0 ] || { echo "uso: $0 <46|48|49|50u|all|host> [--keep-images]" >&2; exit 2; }
command -v podman >/dev/null || { echo "falta podman" >&2; exit 2; }
RC=0
OUT=$(mktemp)
trap 'rm -f "$OUT"' EXIT
for v in "${VERS[@]}"; do
    if [ "$v" = host ]; then
        echo "##### host"
        SRC="$REPO" bash "$HERE/in-container.sh" | tee "$OUT"
        grep -q '^RESULT .* FAIL' "$OUT" && RC=1
        continue
    fi
    img=localhost/kaito-compat:$v
    echo "##### GNOME $v (${BASE[$v]})"
    if ! podman image exists $img; then
        podman build -q --build-arg BASE=${BASE[$v]} --build-arg UBUNTU_MIRROR="${UBUNTU_MIRROR:-}" --build-arg UBUNTU_EXTRAS=$([ $v = 50u ] && echo 1 || echo 0) -t $img -f "$HERE/Containerfile" "$HERE" || { RC=1; continue; }
    fi
    podman run --rm --security-opt label=disable --network none \
        -v "$REPO":/src:ro ${SHOT_DIR:+-v "$SHOT_DIR":/shots -e KAITO_SHOT=/shots/kaito-$v.png} $img bash /src/tests/compat/in-container.sh | tee "$OUT"
    grep -q '^RESULT .* FAIL' "$OUT" && RC=1
    grep -q '^RESULT ' "$OUT" || RC=1
    [ $KEEP = 1 ] || podman rmi -f $img >/dev/null
done
exit $RC
