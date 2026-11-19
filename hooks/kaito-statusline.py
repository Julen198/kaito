#!/usr/bin/env python3
"""statusLine de Claude Code para Kaito: guarda los límites de uso y pinta una línea corta.

Claude Code manda por stdin un JSON con (solo para suscriptores, tras la primera respuesta)
rate_limits.five_hour / rate_limits.seven_day = {used_percentage, resets_at}.
Si vienen, se escriben de forma atómica en $XDG_CACHE_HOME (o ~/.cache)/kaito/claude-usage.json
como {"ts": <epoch>, "rate_limits": {...}}; sin rate_limits no se toca el fichero (no pisa
datos buenos). En stdout sale "<modelo> · 5h 42% · 7d 18%" (sin las partes que falten).
Nunca falla: todo en try/except y salida 0.
"""
import json
import os
import sys
import tempfile
import time


def cache_dir():
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, "kaito")


def usage_path():
    return os.path.join(cache_dir(), "claude-usage.json")


def pct_of(window):
    try:
        v = float(window["used_percentage"])
    except (TypeError, ValueError, KeyError):
        return None
    if v != v or v in (float("inf"), float("-inf")):
        return None
    return int(round(v))


def status_line(data):
    parts = []
    model = data.get("model") if isinstance(data, dict) else None
    name = model.get("display_name") if isinstance(model, dict) else None
    parts.append(str(name) if name else "Claude")
    rl = data.get("rate_limits") if isinstance(data, dict) else None
    if isinstance(rl, dict):
        for key, label in (("five_hour", "5h"), ("seven_day", "7d")):
            win = rl.get(key)
            p = pct_of(win) if isinstance(win, dict) else None
            if p is not None:
                parts.append("%s %d%%" % (label, p))
    return " · ".join(parts)


def save_usage(data, path=None):
    """Escribe claude-usage.json solo si hay rate_limits. Devuelve True si escribió."""
    rl = data.get("rate_limits") if isinstance(data, dict) else None
    if not isinstance(rl, dict) or not rl:
        return False
    path = path or usage_path()
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".claude-usage.", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump({"ts": int(time.time()), "rate_limits": rl}, f)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return True


def selftest():
    d = tempfile.mkdtemp(prefix="kaito-statusline-selftest-")
    path = os.path.join(d, "kaito", "claude-usage.json")
    full = {"model": {"display_name": "Opus"}, "rate_limits": {
        "five_hour": {"used_percentage": 42.4, "resets_at": 1800000000},
        "seven_day": {"used_percentage": 18, "resets_at": 1800600000}}}
    assert status_line(full) == "Opus · 5h 42% · 7d 18%", status_line(full)
    assert status_line({"model": {"display_name": "Sonnet"}}) == "Sonnet"
    only5 = {"model": {"display_name": "X"}, "rate_limits": {"five_hour": {"used_percentage": 3}}}
    assert status_line(only5) == "X · 5h 3%"
    assert status_line({}) == "Claude" and status_line(None) == "Claude"
    assert status_line({"rate_limits": {"five_hour": {"used_percentage": "mal"}}}) == "Claude"
    assert save_usage({"model": {}}, path) is False and not os.path.exists(path)
    assert save_usage({"rate_limits": None}, path) is False
    assert save_usage(full, path) is True
    saved = json.load(open(path))
    assert saved["rate_limits"] == full["rate_limits"] and isinstance(saved["ts"], int)
    assert save_usage({"model": {}}, path) is False  # no pisa los datos buenos
    assert json.load(open(path))["rate_limits"] == full["rate_limits"]
    assert [n for n in os.listdir(os.path.dirname(path)) if n.endswith(".tmp")] == []
    print("selftest OK")


def main():
    data = {}
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        data = {}
    try:
        save_usage(data)
    except Exception:
        pass
    try:
        line = status_line(data)
    except Exception:
        line = "Claude"
    try:
        sys.stdout.write(line + "\n")
    except Exception:
        pass


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        try:
            main()
        except BaseException:
            pass
        sys.exit(0)
