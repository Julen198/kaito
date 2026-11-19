#!/usr/bin/env python3
"""Hook de Claude Code para Kaito: escribe/borra el estado de la sesión.

Un mismo comando sirve para todos los eventos (usa hook_event_name del JSON).
Estado: $XDG_CACHE_HOME (o ~/.cache)/kaito/state/<session_id>.json
Nunca debe romper Claude Code: todo va en try/except y la salida es siempre 0.

PermissionRequest: escribe el estado "needs" con la herramienta y un id de petición y espera
(hasta DECISION_TIMEOUT_S) a que Kaito deje kaito/decisions/<session_id>.json con
{"request": id, "behavior": "allow"|"deny"}. Solo entonces imprime la decisión en stdout.
Mientras tanto Claude Code ya muestra su diálogo en la terminal: si respondes allí, Claude Code
mata este proceso y el estado se limpia (SIGTERM o, si no, PostToolUse/UserPromptSubmit).
"""
import json
import os
import signal
import sys
import tempfile
import time
import uuid

DONE_MSG = "Terminó, esperando tu respuesta"
NEEDS_TYPES = ("permission_prompt", "elicitation_dialog")
DELETE_EVENTS = ("UserPromptSubmit", "PostToolUse", "SessionEnd")
# Debe ser menor que el "timeout" del hook en settings-snippet.json (150 s).
DECISION_TIMEOUT_S = 120
POLL_S = 0.25
DETAIL_MAX = 600


def cache_dir():
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, "kaito")


def state_dir():
    return os.path.join(cache_dir(), "state")


def decisions_dir():
    return os.path.join(cache_dir(), "decisions")


def decision_timeout():
    # Solo para pruebas: KAITO_DECISION_TIMEOUT acorta la espera.
    try:
        return max(0.0, float(os.environ.get("KAITO_DECISION_TIMEOUT", DECISION_TIMEOUT_S)))
    except ValueError:
        return DECISION_TIMEOUT_S


def tool_detail(tool, tool_input):
    """Resumen de una línea (o pocas) de lo que la herramienta va a hacer."""
    ti = tool_input if isinstance(tool_input, dict) else {}
    for k in ("command", "file_path", "notebook_path", "url", "pattern", "path", "query", "prompt"):
        v = ti.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()[:DETAIL_MAX]
    try:
        return json.dumps(ti, ensure_ascii=False)[:DETAIL_MAX] if ti else ""
    except (TypeError, ValueError):
        return ""


def pending_request(existing, now):
    """Id de una petición de permiso que aún espera respuesta de Kaito, o None."""
    if existing and existing.get("state") == "needs" and existing.get("request"):
        if float(existing.get("waitUntil") or 0) > now:
            return existing["request"]
    return None


def decide(payload, existing):
    """Devuelve ('write', dict) | ('delete', None) | (None, None)."""
    ev = payload.get("hook_event_name")
    cwd = payload.get("cwd") or ""
    now = int(time.time())
    if ev in DELETE_EVENTS:
        return "delete", None
    if ev == "Notification":
        kind = payload.get("notification_type")
        if kind in NEEDS_TYPES:
            # No pisar una petición de PermissionRequest que sigue esperando (pierde los botones).
            if pending_request(existing, now):
                return None, None
            msg = str(payload.get("message") or "Necesita tu atención")
            return "write", {"state": "needs", "message": msg, "cwd": cwd, "ts": now}
        if kind == "idle_prompt":
            if existing and existing.get("state") == "needs":
                return None, None
            return "write", {"state": "done", "message": DONE_MSG, "cwd": cwd, "ts": now}
        return None, None
    if ev == "PreToolUse" and payload.get("tool_name") == "AskUserQuestion":
        qs = (payload.get("tool_input") or {}).get("questions") or [{}]
        msg = str((qs[0] or {}).get("question") or "Te hace una pregunta")
        return "write", {"state": "needs", "message": msg, "cwd": cwd, "ts": now}
    if ev == "PermissionRequest":
        tool = str(payload.get("tool_name") or "")
        if tool == "AskUserQuestion":
            return None, None  # ya lo cubre PreToolUse con la pregunta
        if tool == "ExitPlanMode":
            return "write", {"state": "needs", "message": "Plan listo: revísalo en la terminal",
                             "cwd": cwd, "ts": now}
        detail = tool_detail(tool, payload.get("tool_input"))
        return "write", {"state": "needs", "message": "Pide permiso para usar " + (tool or "una herramienta"),
                         "kind": "permission", "tool": tool, "detail": detail,
                         "request": uuid.uuid4().hex, "waitUntil": now + int(decision_timeout()),
                         "cwd": cwd, "ts": now}
    if ev == "Stop":
        return "write", {"state": "done", "message": DONE_MSG, "cwd": cwd, "ts": now}
    return None, None


def write_json(path, data):
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
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


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def valid_sid(payload):
    sid = str(payload.get("session_id") or "")
    # Evita path traversal: el id solo puede ser un nombre de fichero simple.
    if not sid or sid != os.path.basename(sid) or sid.startswith("."):
        return None
    if "claude-mem-observer" in str(payload.get("cwd") or ""):
        return None
    return sid


def handle(payload, sdir):
    """Aplica el evento al fichero de estado. Devuelve lo escrito (dict) o None."""
    sid = valid_sid(payload)
    if not sid:
        return None
    path = os.path.join(sdir, sid + ".json")
    existing = read_json(path)
    if not isinstance(existing, dict):
        existing = None
    action, data = decide(payload, existing)
    if action == "delete":
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
    elif action == "write":
        write_json(path, data)
        return data
    return None


def clear_if_request(spath, request):
    """Borra el estado solo si sigue siendo el de esta petición."""
    cur = read_json(spath)
    if isinstance(cur, dict) and cur.get("request") == request:
        try:
            os.unlink(spath)
        except OSError:
            pass


def decision_output(behavior):
    decision = {"behavior": behavior}
    if behavior == "deny":
        decision["message"] = "El usuario lo ha denegado desde Kaito."
    return {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": decision}}


def wait_decision(sid, request, spath, ddir, timeout):
    """Espera el fichero de decisión de Kaito. Devuelve el dict de salida o None (sin decisión)."""
    dpath = os.path.join(ddir, sid + ".json")
    deadline = time.monotonic() + timeout
    while True:
        d = read_json(dpath)
        if isinstance(d, dict) and d.get("request") == request and d.get("behavior") in ("allow", "deny"):
            try:
                os.unlink(dpath)
            except OSError:
                pass
            clear_if_request(spath, request)
            return decision_output(d["behavior"])
        cur = read_json(spath)
        # Otro evento (respuesta en la terminal, nueva petición) ya reemplazó el estado.
        if not (isinstance(cur, dict) and cur.get("request") == request):
            return None
        if time.monotonic() >= deadline:
            return None
        time.sleep(POLL_S)


def permission_flow(payload, sdir, ddir, timeout):
    """PermissionRequest completo: estado + espera. Devuelve la salida JSON (dict) o None."""
    data = handle(payload, sdir)
    if not data or not data.get("request"):
        return None
    sid = valid_sid(payload)
    spath = os.path.join(sdir, sid + ".json")
    request = data["request"]
    # Una decisión vieja de otra petición no vale.
    try:
        os.unlink(os.path.join(ddir, sid + ".json"))
    except OSError:
        pass

    def on_term(_signum, _frame):
        # Claude Code nos mata si respondes en la terminal: deja el estado limpio.
        try:
            clear_if_request(spath, request)
        finally:
            os._exit(0)

    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        try:
            signal.signal(sig, on_term)
        except (ValueError, OSError):
            pass
    return wait_decision(sid, request, spath, ddir, timeout)


def selftest():
    import shutil
    d = tempfile.mkdtemp(prefix="kaito-selftest-")
    try:
        def run(p):
            handle(p, d)

        def read(sid):
            p = os.path.join(d, sid + ".json")
            if not os.path.exists(p):
                return None
            with open(p, encoding="utf-8") as f:
                return json.load(f)

        base = {"session_id": "s1", "cwd": "/home/x/repo"}
        run({**base, "hook_event_name": "Notification", "notification_type": "permission_prompt",
             "message": "Claude necesita permiso para Bash"})
        assert read("s1")["state"] == "needs" and "permiso" in read("s1")["message"]
        run({**base, "hook_event_name": "Notification", "notification_type": "idle_prompt"})
        assert read("s1")["state"] == "needs", "idle_prompt no debe degradar needs"
        run({**base, "hook_event_name": "PostToolUse", "tool_name": "Bash"})
        assert read("s1") is None
        run({**base, "hook_event_name": "Stop"})
        assert read("s1")["state"] == "done" and read("s1")["message"] == DONE_MSG
        run({**base, "hook_event_name": "Notification", "notification_type": "idle_prompt"})
        assert read("s1")["state"] == "done"
        run({**base, "hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion",
             "tool_input": {"questions": [{"question": "¿Qué framework?", "options": []}]}})
        assert read("s1")["state"] == "needs" and read("s1")["message"] == "¿Qué framework?"
        run({**base, "hook_event_name": "UserPromptSubmit"})
        assert read("s1") is None
        run({**base, "hook_event_name": "Stop"})
        run({**base, "hook_event_name": "SessionEnd"})
        assert read("s1") is None
        run({**base, "hook_event_name": "PreToolUse", "tool_name": "Bash"})
        run({**base, "hook_event_name": "Notification", "notification_type": "auth_success"})
        assert read("s1") is None, "eventos no relevantes no escriben"
        run({"session_id": "s2", "cwd": "/x/claude-mem-observer-foo", "hook_event_name": "Stop"})
        assert read("s2") is None, "observer ignorado"
        run({"session_id": "../evil", "cwd": "/x", "hook_event_name": "Stop"})
        assert not os.path.exists(os.path.join(os.path.dirname(d), "evil.json"))
        assert not [n for n in os.listdir(d) if n.startswith(".tmp-")], "sin temporales"

        # PermissionRequest: estado con herramienta y petición; la notificación no lo pisa.
        pr = {**base, "hook_event_name": "PermissionRequest", "tool_name": "Bash",
              "tool_input": {"command": "rm -rf node_modules", "description": "x"}}
        st = handle(pr, d)
        assert st["state"] == "needs" and st["tool"] == "Bash" and st["detail"] == "rm -rf node_modules"
        assert st["request"] and st["waitUntil"] > time.time()
        run({**base, "hook_event_name": "Notification", "notification_type": "permission_prompt",
             "message": "Claude necesita permiso"})
        assert read("s1")["request"] == st["request"], "permission_prompt no pisa la petición"
        run({**base, "hook_event_name": "PostToolUse", "tool_name": "Bash"})
        assert read("s1") is None
        assert handle({**base, "hook_event_name": "PermissionRequest", "tool_name": "AskUserQuestion"}, d) is None
        assert handle({**base, "hook_event_name": "PermissionRequest", "tool_name": "ExitPlanMode"}, d).get("request") is None
        assert tool_detail("Edit", {"file_path": "/a/b.py", "old_string": "x"}) == "/a/b.py"

        # Espera de decisión: allow, deny, decisión de otra petición (se ignora) y timeout.
        dd = os.path.join(d, "decisions")
        for behavior in ("allow", "deny"):
            st = handle(pr, d)
            write_json(os.path.join(dd, "s1.json"), {"request": st["request"], "behavior": behavior})
            out = wait_decision("s1", st["request"], os.path.join(d, "s1.json"), dd, 2)
            assert out["hookSpecificOutput"]["decision"]["behavior"] == behavior
            assert out["hookSpecificOutput"]["hookEventName"] == "PermissionRequest"
            assert read("s1") is None and not os.path.exists(os.path.join(dd, "s1.json"))
        st = handle(pr, d)
        write_json(os.path.join(dd, "s1.json"), {"request": "otra", "behavior": "allow"})
        t0 = time.monotonic()
        assert wait_decision("s1", st["request"], os.path.join(d, "s1.json"), dd, 0.6) is None
        assert time.monotonic() - t0 >= 0.5, "espera hasta el timeout"
        assert read("s1")["request"] == st["request"], "timeout: el estado queda (sigue el diálogo)"
        run({**base, "hook_event_name": "UserPromptSubmit"})
        assert wait_decision("s1", st["request"], os.path.join(d, "s1.json"), dd, 5) is None, \
            "estado reemplazado: deja de esperar"
        os.environ["KAITO_TASK"] = "1"
        try:
            assert is_kaito_task(), "KAITO_TASK=1 se ignora"
        finally:
            del os.environ["KAITO_TASK"]
        assert not is_kaito_task()
        print("selftest OK")
    finally:
        shutil.rmtree(d, ignore_errors=True)


def is_kaito_task():
    """Las tareas programadas de Kaito (tasks.js) lanzan claude con KAITO_TASK=1: no son agentes del usuario."""
    return os.environ.get("KAITO_TASK") == "1"


def main():
    if "--selftest" in sys.argv:
        selftest()
        return
    if is_kaito_task():
        return
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            return
        if payload.get("hook_event_name") == "PermissionRequest":
            out = permission_flow(payload, state_dir(), decisions_dir(), decision_timeout())
            if out:
                sys.stdout.write(json.dumps(out))
                sys.stdout.flush()
        else:
            handle(payload, state_dir())
    except Exception:
        pass  # nunca romper Claude Code


if __name__ == "__main__":
    main()
    sys.exit(0)
