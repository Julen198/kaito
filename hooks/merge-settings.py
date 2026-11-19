#!/usr/bin/env python3
"""Fusiona (o quita) los hooks y la statusLine de Kaito en ~/.claude/settings.json.

Uso:
  merge-settings.py install   [--settings RUTA] [--statusline] [--apply]
  merge-settings.py uninstall [--settings RUTA] [--apply]

Sin --apply solo muestra el resumen de cambios (no escribe nada). Con --apply hace
copia de seguridad (settings.json.bak-kaito-<fecha>) y escribe de forma atómica.
Usa hooks/settings-snippet.json como plantilla (__KAITO_HOOKS_DIR__ -> esta carpeta).
Solo biblioteca estándar. Códigos de salida: 0 hay cambios, 10 sin cambios, 1 error.
"""
import argparse
import copy
import json
import os
import shlex
import shutil
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK_NAME = "kaito-hook.py"
STATUS_NAME = "kaito-statusline.py"


def cmd_script(command):
    """Primer token del comando (la ruta del script), o '' si no se puede parsear."""
    try:
        parts = shlex.split(command)
    except ValueError:
        parts = command.split()
    return parts[0] if parts else ""


def is_kaito(command, name):
    return os.path.basename(cmd_script(command)) == name


def load_template():
    with open(os.path.join(HERE, "settings-snippet.json"), encoding="utf-8") as f:
        raw = f.read()
    raw = raw.replace("__KAITO_HOOKS_DIR__", HERE.replace("\\", "\\\\").replace('"', '\\"'))
    tpl = json.loads(raw)
    tpl.pop("_comment", None)
    for groups in tpl.get("hooks", {}).values():
        for g in groups:
            for h in g.get("hooks", []):
                h["command"] = shlex.quote(h["command"])
    if "statusLine" in tpl:
        tpl["statusLine"]["command"] = shlex.quote(tpl["statusLine"]["command"])
    return tpl


def strip_kaito(settings, keep_path, report):
    """Quita hooks de Kaito cuya ruta != keep_path (None = quita todos). Devuelve nº quitados."""
    hooks = settings.get("hooks")
    if not isinstance(hooks, dict):
        return
    for event in list(hooks):
        groups = hooks[event]
        if not isinstance(groups, list):
            continue
        new_groups = []
        for g in groups:
            hs = g.get("hooks") if isinstance(g, dict) else None
            if not isinstance(hs, list):
                new_groups.append(g)
                continue
            kept = []
            for h in hs:
                c = h.get("command", "") if isinstance(h, dict) else ""
                if is_kaito(c, HOOK_NAME) and (keep_path is None or cmd_script(c) != keep_path):
                    report.append("- %s: quitado %s" % (event, cmd_script(c)))
                else:
                    kept.append(h)
            if kept:
                if len(kept) != len(hs):
                    g = dict(g)
                    g["hooks"] = kept
                new_groups.append(g)
        if new_groups:
            hooks[event] = new_groups
        else:
            del hooks[event]
    if not hooks:
        del settings["hooks"]


def has_path(groups, path):
    for g in groups:
        for h in (g.get("hooks") or []) if isinstance(g, dict) else []:
            if isinstance(h, dict) and cmd_script(h.get("command", "")) == path:
                return True
    return False


def do_install(settings, want_status, report):
    tpl = load_template()
    hook_path = os.path.join(HERE, HOOK_NAME)
    strip_kaito(settings, hook_path, report)
    hooks = settings.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise SystemExit("error: 'hooks' en settings.json no es un objeto")
    for event, groups in tpl["hooks"].items():
        cur = hooks.setdefault(event, [])
        if not isinstance(cur, list):
            raise SystemExit("error: hooks.%s no es una lista" % event)
        if has_path(cur, hook_path):
            report.append("= %s: ya presente" % event)
        else:
            cur.extend(copy.deepcopy(groups))
            report.append("+ %s: añadido %s" % (event, hook_path))
    if want_status:
        sl = settings.get("statusLine")
        mine = tpl["statusLine"]
        sl_cmd = sl.get("command", "") if isinstance(sl, dict) else ""
        if sl is None:
            settings["statusLine"] = mine
            report.append("+ statusLine: añadida")
        elif is_kaito(sl_cmd, STATUS_NAME):
            if cmd_script(sl_cmd) != cmd_script(mine["command"]):
                settings["statusLine"] = mine
                report.append("~ statusLine: ruta de Kaito actualizada")
            else:
                report.append("= statusLine: ya presente")
        else:
            report.append("! statusLine: ya tienes una (%s), no se toca" % sl_cmd)


def do_uninstall(settings, report):
    strip_kaito(settings, None, report)
    sl = settings.get("statusLine")
    if isinstance(sl, dict) and is_kaito(sl.get("command", ""), STATUS_NAME):
        del settings["statusLine"]
        report.append("- statusLine: quitada")


def atomic_write(path, data):
    mode = None
    if os.path.exists(path):
        mode = os.stat(path).st_mode & 0o777
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".settings-kaito-", dir=d)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode if mode is not None else 0o600)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("action", choices=["install", "uninstall"])
    ap.add_argument("--settings", default=os.path.join(os.path.expanduser("~"), ".claude", "settings.json"))
    ap.add_argument("--statusline", action="store_true", help="(install) añade también la statusLine si no hay una")
    ap.add_argument("--apply", action="store_true", help="escribe los cambios (si no, solo los muestra)")
    a = ap.parse_args()

    path = os.path.realpath(a.settings)
    settings = {}
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                txt = f.read()
            settings = json.loads(txt) if txt.strip() else {}
        except (OSError, ValueError) as e:
            print("error: no se puede leer %s como JSON (%s). No se modifica nada." % (path, e), file=sys.stderr)
            return 1
        if not isinstance(settings, dict):
            print("error: %s no es un objeto JSON." % path, file=sys.stderr)
            return 1
    before = copy.deepcopy(settings)

    report = []
    try:
        if a.action == "install":
            do_install(settings, a.statusline, report)
        else:
            do_uninstall(settings, report)
    except SystemExit as e:
        print(e, file=sys.stderr)
        return 1

    print("Fichero: %s" % path)
    for line in report:
        print("  " + line)
    if settings == before:
        print("Sin cambios.")
        return 10
    if not a.apply:
        print("(vista previa: aún no se ha escrito nada)")
        return 0

    if os.path.exists(path):
        bak = "%s.bak-kaito-%s" % (path, time.strftime("%Y%m%d-%H%M%S"))
        shutil.copy2(path, bak)
        print("Copia de seguridad: %s" % bak)
    atomic_write(path, json.dumps(settings, indent=2, ensure_ascii=False) + "\n")
    print("Escrito %s" % path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
