#!/usr/bin/env bash
# Instalador en una línea de Kaito.
#   curl -fsSL https://raw.githubusercontent.com/Julen198/kaito/main/bootstrap.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/Julen198/kaito/main/bootstrap.sh | bash -s -- --yes
# Variables: KAITO_REPO (url del repo), KAITO_BRANCH (main), KAITO_HOME (~/.local/share/kaito-src)
set -euo pipefail

REPO_DEFAULT="https://github.com/Julen198/kaito.git"
KAITO_REPO="${KAITO_REPO:-$REPO_DEFAULT}"
KAITO_BRANCH="${KAITO_BRANCH:-main}"
KAITO_HOME="${KAITO_HOME:-$HOME/.local/share/kaito-src}"
BIN_DIR="$HOME/.local/bin"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; }
die()  { fail "$*"; exit 1; }

# Si se ejecuta desde dentro de un checkout (git clone … && ./bootstrap.sh), úsalo.
SELF_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -n "$SELF_DIR" ] && [ -d "$SELF_DIR/.git" ] && [ -f "$SELF_DIR/install.sh" ]; then
  if [ "$SELF_DIR" != "$(realpath -m "$KAITO_HOME")" ] && [ ! -e "$KAITO_HOME" ]; then
    KAITO_HOME="$SELF_DIR"
  fi
  if [ "$KAITO_REPO" = "$REPO_DEFAULT" ]; then
    KAITO_REPO="$(git -C "$SELF_DIR" remote get-url origin 2>/dev/null || echo "$REPO_DEFAULT")"
  fi
fi

if [ -z "$KAITO_REPO" ]; then
  fail "No se ha indicado el repositorio de Kaito."
  echo "  Define KAITO_REPO, p. ej.:  KAITO_REPO=git@github.com:empresa/kaito.git bash bootstrap.sh" >&2
  exit 1
fi

info "Comprobando requisitos"
missing=0
for c in git python3 glib-compile-schemas; do
  if command -v "$c" >/dev/null 2>&1; then ok "$c"; else fail "falta $c"; missing=1; fi
done
if command -v gnome-shell >/dev/null 2>&1; then ok "gnome-shell"; else warn "gnome-shell no encontrado: ¿estás en GNOME?"; fi
[ "$missing" = 0 ] || die "Instala lo que falta (Fedora: dnf install git python3 glib2-devel / Ubuntu: apt install git python3 libglib2.0-bin)."

info "Obteniendo Kaito en $KAITO_HOME"
export GIT_TERMINAL_PROMPT="${GIT_TERMINAL_PROMPT:-1}"
hint_auth() {
  fail "No se pudo acceder al repositorio."
  echo "  ¿Tienes acceso al repo? Prueba: git clone $KAITO_REPO $KAITO_HOME" >&2
}
if [ -d "$KAITO_HOME/.git" ]; then
  cur="$(git -C "$KAITO_HOME" remote get-url origin 2>/dev/null || true)"
  if [ "$cur" != "$KAITO_REPO" ]; then
    die "$KAITO_HOME es un checkout de otro remoto ($cur). Usa otro KAITO_HOME o bórralo."
  fi
  git -C "$KAITO_HOME" pull --ff-only || { hint_auth; exit 1; }
  ok "Actualizado"
elif [ -e "$KAITO_HOME" ] && [ -n "$(ls -A "$KAITO_HOME" 2>/dev/null)" ]; then
  die "$KAITO_HOME existe y no es un checkout de git. Muévelo o usa otro KAITO_HOME."
else
  mkdir -p "$(dirname "$KAITO_HOME")"
  git clone --depth 1 -b "$KAITO_BRANCH" "$KAITO_REPO" "$KAITO_HOME" || { hint_auth; exit 1; }
  ok "Clonado"
fi

info "Ejecutando install.sh"
"$KAITO_HOME/install.sh" "$@"

info "Instalando el comando kaito"
mkdir -p "$BIN_DIR"
chmod +x "$KAITO_HOME/bin/kaito"
ln -sfn "$KAITO_HOME/bin/kaito" "$BIN_DIR/kaito"
ok "$BIN_DIR/kaito -> $KAITO_HOME/bin/kaito"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    warn "$BIN_DIR no está en tu PATH. Añádelo:"
    echo "     bash:  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc"
    echo "     zsh:   echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc"
    echo "     fish:  fish_add_path ~/.local/bin"
    ;;
esac

echo
ok "Kaito $(cat "$KAITO_HOME/VERSION" 2>/dev/null || echo '?') instalado."
echo "  Actualizar: kaito update   ·   Diagnóstico: kaito doctor   ·   Desinstalar: kaito uninstall"
