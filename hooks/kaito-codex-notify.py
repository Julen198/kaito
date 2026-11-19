#!/usr/bin/env python3
"""Aviso de Codex CLI para Kaito: marca la sesión como "terminó" al acabar cada turno.

Se configura en ~/.codex/config.toml:  notify = ["python3", "/ruta/kaito-codex-notify.py"]
Codex añade UN argumento: un JSON ({"type":"agent-turn-complete","thread-id":...,"cwd":...}).
Estado: $XDG_CACHE_HOME (o ~/.cache)/kaito/state/codex-<id>.json
Nunca guarda el mensaje completo del asistente ni los mensajes del usuario.
Nunca debe romper Codex: salida 0 siempre y nada por stdout.
"""
import hashlib
import json
import os
import re
import sys
import tempfile
import time

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
MSG_MAX = 160


def state_dir():
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, "kaito", "state")


def first_line(text):
    for line in str(text or "").splitlines():
        line = line.strip().lstrip("#>*- ").strip()
        if line:
            return line if len(line) <= MSG_MAX else line[:MSG_MAX - 1].rstrip() + "…"
    return ""


def session_id(payload, cwd):
    tid = payload.get("thread-id")
    if isinstance(tid, str) and ID_RE.match(tid):
        return tid
    return "cwd-" + hashlib.sha1(cwd.encode("utf-8", "replace")).hexdigest()[:12]


def write_json(path, data):
    d = os.path.dirname(path)
    os.makedirs(d, mode=0o755, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def handle(payload, sdir=None):
    """Escribe el estado; devuelve el dict escrito o None si se ignora."""
    if not isinstance(payload, dict) or payload.get("type") != "agent-turn-complete":
        return None
    cwd = payload.get("cwd")
    if not isinstance(cwd, str) or not cwd:
        cwd = os.getcwd()
    sid = session_id(payload, cwd)
    turn, thread = payload.get("turn-id"), payload.get("thread-id")
    st = {"state": "done", "provider": "codex", "cwd": cwd,
          "message": first_line(payload.get("last-assistant-message")),
          "ts": time.time(),
          "turn": turn if isinstance(turn, str) else None,
          "thread": thread if isinstance(thread, str) else None}
    write_json(os.path.join(sdir or state_dir(), "codex-" + sid + ".json"), st)
    return st


def selftest():
    import shutil
    d = tempfile.mkdtemp(prefix="kaito-codex-selftest-")
    old = os.environ.get("XDG_CACHE_HOME")
    os.environ["XDG_CACHE_HOME"] = d
    try:
        sd = state_dir()

        def files():
            return sorted(n for n in os.listdir(sd)) if os.path.isdir(sd) else []

        def read(n):
            with open(os.path.join(sd, n), encoding="utf-8") as f:
                return json.load(f)

        st = handle({"type": "agent-turn-complete", "thread-id": "01a1-b_2", "turn-id": "t1",
                     "cwd": "/home/x/repo", "input-messages": ["secreto"],
                     "last-assistant-message": "## Hecho\nlínea dos"})
        assert files() == ["codex-01a1-b_2.json"], files()
        j = read("codex-01a1-b_2.json")
        assert j["state"] == "done" and j["provider"] == "codex" and j["cwd"] == "/home/x/repo"
        assert j["message"] == "Hecho" and j["turn"] == "t1" and j["thread"] == "01a1-b_2"
        assert isinstance(j["ts"], float) and st["message"] == "Hecho"
        assert "secreto" not in json.dumps(j) and "línea dos" not in json.dumps(j)

        handle({"type": "agent-turn-complete", "cwd": "/home/x/otro", "last-assistant-message": ""})
        want = "codex-cwd-" + hashlib.sha1(b"/home/x/otro").hexdigest()[:12] + ".json"
        assert want in files(), files()
        j = read(want)
        assert j["message"] == "" and j["thread"] is None and j["turn"] is None

        n = len(files())
        handle({"type": "agent-turn-complete", "thread-id": "../../evil", "cwd": "/x"})
        assert len(files()) == n + 1 and not os.path.exists(os.path.join(d, "evil.json"))
        assert not [f for f in os.listdir(sd) if "/" in f or f.startswith("codex-..")]
        assert read("codex-cwd-" + hashlib.sha1(b"/x").hexdigest()[:12] + ".json")["thread"] == "../../evil"

        n = len(files())
        assert handle({"type": "other", "thread-id": "zzz", "cwd": "/y"}) is None
        assert len(files()) == n and "codex-zzz.json" not in files()

        main(["{no es json"])
        main([])
        main(["[1,2]"])
        assert len(files()) == n

        long = "  - **" + "á" * 400 + "**\nsegunda línea"
        handle({"type": "agent-turn-complete", "thread-id": "long1", "cwd": "/z", "last-assistant-message": "\n\n" + long})
        m = read("codex-long1.json")["message"]
        assert 0 < len(m) <= MSG_MAX and m.endswith("…") and "segunda" not in m and m.startswith("á"), m
        assert not [f for f in os.listdir(sd) if f.startswith(".tmp-")], "sin temporales"
        print("selftest OK")
    except AssertionError as e:
        print("selftest FALLÓ: %r" % (e,), file=sys.stderr)
        sys.exit(1)
    finally:
        if old is None:
            os.environ.pop("XDG_CACHE_HOME", None)
        else:
            os.environ["XDG_CACHE_HOME"] = old
        shutil.rmtree(d, ignore_errors=True)


def main(argv):
    try:
        if not argv:
            return
        handle(json.loads(argv[-1]))
    except Exception as e:  # nunca romper Codex
        print("kaito-codex-notify: %s" % (e.__class__.__name__,), file=sys.stderr)


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
        sys.exit(0)
    main(sys.argv[1:])
    sys.exit(0)
