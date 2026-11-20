#!/usr/bin/env python3
"""End-to-end voice test: places a REAL audio call into the deployed contact flow.

How it works
  1. connect.StartWebRTCContact opens an audio contact into the live flow (no
     phone number needed).
  2. tools/webrtc-caller (Puppeteer + Amazon Chime SDK) joins the call headless
     and plays pre-synthesized Spanish audio clips (tests/calls/audio/*.mp3).
  3. The "brain" below polls the live Q in Connect transcript; for every new
     BOT turn it picks the reply from the case's ordered keyword responders and
     plays it once the bot's audio goes quiet (VAD).
  4. After hang-up it VERIFIES the outcome: the order row in DynamoDB (joined by
     contactId) and the MCP tool calls the agent made (Q in Connect ListSpans).

Case file (tests/calls/cases/<name>.json):
  {
    "description": "...",
    "max_call_seconds": 240,
    "hangup_on": ["número de pedido", "gracias por llamar"],   # phrases the bot SAYS (Spanish)
    "dialogue": [                                              # first match wins
      {"match": ["confirmas", "correcto"], "say": "si-correcto"},
      {"match": ["qué pizza"], "say_seq": ["pizza-barbacoa", "pizza-hawaiana"]}
    ],
    "verify": {
      "orders": 1,                       # exact number of rows for this contact
      "total": 27970,                    # optional, server-computed total
      "items": {"napolitana": 2},        # optional, pizzaId -> quantity
      "tools_called": ["validate_customer", "create_order"],   # optional
      "max_tool_errors": 0               # optional
    }
  }

Usage
  python scripts/call-test.py                 # run every case
  python scripts/call-test.py happy-path      # run one case
  python scripts/call-test.py --list
Env: AWS_PROFILE, AWS_REGION, PROJECT_NAME, ENV_NAME (see scripts/stack_env.py).
Prereqs: `cd tools/webrtc-caller && npm ci && npm run build`, then
         `python scripts/synthesize-audio.py`.
Note: test calls create REAL rows (marked with contact attribute test_call=true).
"""
import argparse
import json
import queue
import subprocess
import sys
import threading
import time
import unicodedata
import uuid
from datetime import datetime
from pathlib import Path

from boto3.dynamodb.conditions import Attr

sys.path.insert(0, str(Path(__file__).resolve().parent))
from stack_env import load_env  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
CALLER_JS = REPO / "tools" / "webrtc-caller" / "caller.js"
AUDIO_DIR = REPO / "tests" / "calls" / "audio"
CASES_DIR = REPO / "tests" / "calls" / "cases"
RUNS_DIR = REPO / "tests" / "calls" / "runs"

VAD_SILENCE_BEFORE_SPEAK = 0.8   # bot must be quiet this long before we talk
TRANSCRIPT_POLL_INTERVAL = 1.0
HANGUP_GRACE = 4.0               # let the bot finish its goodbye
SPANS_SETTLE_SECONDS = 150       # ListSpans lags the call by ~1-2 minutes


def norm(text):
    """Lowercase + strip accents so 'Confirmás' matches 'confirmas'."""
    text = unicodedata.normalize("NFKD", text or "").lower()
    return "".join(c for c in text if not unicodedata.combining(c))


def as_list(v):
    return v if isinstance(v, list) else [v]


# ── transcript ───────────────────────────────────────────────────────────────
def bot_messages(qconnect, assistant_id, session_id):
    msgs, kw = [], dict(assistantId=assistant_id, sessionId=session_id, maxResults=100)
    while True:
        r = qconnect.list_messages(**kw)
        msgs += r.get("messages", [])
        if not r.get("nextToken"):
            break
        kw["nextToken"] = r["nextToken"]
    msgs.sort(key=lambda m: str(m.get("timestamp", "")))
    out = []
    for m in msgs:
        if m.get("participant") != "BOT":
            continue
        txt = ((m.get("value") or {}).get("text") or {}).get("value", "")
        if txt:
            out.append(txt)
    return out


# ── one call ─────────────────────────────────────────────────────────────────
def place_call(name, case, run_dir, env, connect, qconnect):
    dialogue = case["dialogue"]
    hangup_on = [norm(h) for h in as_list(case.get("hangup_on", []))]
    max_secs = int(case.get("max_call_seconds", 240))

    needed = {k for d in dialogue for k in (d.get("say_seq") or [d["say"]])}
    missing = sorted(k for k in needed if not (AUDIO_DIR / f"{k}.mp3").exists())
    if missing:
        raise SystemExit(f"missing audio {missing}: run scripts/synthesize-audio.py")

    r = connect.start_web_rtc_contact(
        InstanceId=env.instance_id, ContactFlowId=env.contact_flow_id,
        ClientToken=str(uuid.uuid4()),
        ParticipantDetails={"DisplayName": f"call-test-{name}"},
        Attributes={"test_call": "true", "test_case": name},
    )
    contact_id = r["ContactId"]
    conn_file = run_dir / f"{name}.connection.json"
    conn_file.write_text(json.dumps({"Meeting": r["ConnectionData"]["Meeting"],
                                     "Attendee": r["ConnectionData"]["Attendee"]}, default=str))
    print(f"  contact {contact_id}")

    proc = subprocess.Popen(
        ["node", str(CALLER_JS), "--connection-file", str(conn_file),
         "--audio-dir", str(AUDIO_DIR), "--max-seconds", str(max_secs + 60)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace")
    events, stderr_lines = queue.Queue(), []
    threading.Thread(target=lambda: [events.put(l) for l in proc.stdout], daemon=True).start()
    threading.Thread(target=lambda: [stderr_lines.append(l.rstrip()) for l in proc.stderr],
                     daemon=True).start()

    def send(cmd):
        try:
            proc.stdin.write(json.dumps(cmd) + "\n")
            proc.stdin.flush()
        except Exception:  # noqa: BLE001 — caller already gone
            pass

    t0 = time.time()
    st = {"vad": "silence", "vad_since": t0, "playing": False, "joined": False,
          "stopped": False, "error": None}
    log, exchanges, seq_state = [], [], {}
    pending, session_id, seen, last_poll, last_done = None, None, 0, 0.0, 0.0
    hangup_at = None

    while time.time() - t0 < max_secs:
        now = time.time()
        while True:
            try:
                raw = events.get_nowait().strip()
            except queue.Empty:
                break
            try:
                ev = json.loads(raw)
            except json.JSONDecodeError:
                continue
            log.append({"t": round(now - t0, 2), **ev})
            kind = ev.get("event")
            if kind == "joined":
                st["joined"] = True
            elif kind == "vad":
                st["vad"], st["vad_since"] = ev.get("state"), now
            elif kind == "playstart":
                st["playing"] = True
            elif kind == "playdone":
                st["playing"], last_done = False, now
            elif kind == "stopped":
                st["stopped"] = True
            elif kind == "error":
                st["error"] = ev.get("message")

        if st["stopped"] or proc.poll() is not None or (hangup_at and now >= hangup_at):
            break

        if session_id is None and now - t0 > 2:
            try:
                ct = connect.describe_contact(InstanceId=env.instance_id,
                                              ContactId=contact_id)["Contact"]
                arn = (ct.get("WisdomInfo") or {}).get("SessionArn")
                session_id = arn.split("/")[-1] if arn else None
            except Exception:  # noqa: BLE001 — not ready yet
                pass

        if session_id and not hangup_at and now - last_poll >= TRANSCRIPT_POLL_INTERVAL:
            last_poll = now
            try:
                bots = bot_messages(qconnect, env.assistant_id, session_id)
            except Exception:  # noqa: BLE001
                bots = []
            for text in bots[seen:]:
                low = norm(text)
                print(f"  BOT: {text[:150]}")
                log.append({"t": round(now - t0, 2), "event": "bot", "text": text})
                if any(h in low for h in hangup_on):
                    hangup_at, pending = now + HANGUP_GRACE, None
                    break
                for i, d in enumerate(dialogue):
                    if any(norm(m) in low for m in as_list(d["match"])):
                        if "say_seq" in d:
                            idx = seq_state.get(i, 0)
                            pending = d["say_seq"][min(idx, len(d["say_seq"]) - 1)]
                            seq_state[i] = idx + 1
                        else:
                            pending = d["say"]
                        exchanges.append({"bot": text, "say": pending})
                        break
            seen = len(bots)

        if (pending and st["joined"] and not st["playing"] and not hangup_at
                and st["vad"] == "silence"
                and now - st["vad_since"] >= VAD_SILENCE_BEFORE_SPEAK
                and now - last_done >= 0.3):
            print(f"  CALLER: <{pending}>")
            send({"cmd": "play", "file": f"{pending}.mp3"})
            pending = None
        time.sleep(0.05)

    duration = round(time.time() - t0, 1)
    try:
        connect.stop_contact(InstanceId=env.instance_id, ContactId=contact_id)
    except Exception:  # noqa: BLE001 — already disconnected
        pass
    send({"cmd": "hangup"})
    try:
        proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        proc.kill()

    status = ("COMPLETED" if hangup_at else "ERROR" if st["error"]
              else "DISCONNECTED" if st["stopped"] else "TIMEOUT")
    return {"case": name, "status": status, "contactId": contact_id, "sessionId": session_id,
            "durationSec": duration, "exchanges": exchanges, "events": log,
            "callerStderr": stderr_lines[-40:]}


# ── verification ─────────────────────────────────────────────────────────────
def tool_spans(qconnect, assistant_id, session_id):
    spans, kw = [], dict(assistantId=assistant_id, sessionId=session_id)
    while True:
        r = qconnect.list_spans(**kw)
        spans += r.get("spans", [])
        if not r.get("nextToken"):
            break
        kw["nextToken"] = r["nextToken"]
    out = []
    for s in spans:
        if s.get("spanName") != "execute_tool":
            continue
        name, args = None, None
        for m in (s.get("attributes") or {}).get("inputMessages", []) or []:
            for v in m.get("values", []) or []:
                if v.get("toolUse"):
                    name, args = v["toolUse"].get("name"), v["toolUse"].get("arguments")
        out.append({"tool": (name or "").split("___")[-1], "status": s.get("status"),
                    "args": args})
    return out


def verify(case, result, env, ddb, qconnect):
    exp, checks = case.get("verify", {}), []

    def check(label, ok, detail=""):
        checks.append({"check": label, "ok": bool(ok), "detail": detail})

    rows = ddb.Table(env.table("orders")).scan(
        FilterExpression=Attr("contactId").eq(result["contactId"])).get("Items", [])
    if "orders" in exp:
        check(f"orders == {exp['orders']}", len(rows) == exp["orders"], f"found {len(rows)}")
    if rows and "total" in exp:
        check(f"total == {exp['total']}", int(rows[0]["total"]) == exp["total"],
              f"got {rows[0]['total']}")
    if rows and "items" in exp:
        got = {i["pizzaId"]: int(i["quantity"]) for i in rows[0].get("items", [])}
        check(f"items == {exp['items']}", got == exp["items"], f"got {got}")

    if result.get("sessionId") and ("tools_called" in exp or "max_tool_errors" in exp):
        spans, deadline = [], time.time() + SPANS_SETTLE_SECONDS
        want = set(exp.get("tools_called", []))
        while time.time() < deadline:
            try:
                spans = tool_spans(qconnect, env.assistant_id, result["sessionId"])
            except Exception:  # noqa: BLE001 — trace not available yet
                spans = []
            if want <= {s["tool"] for s in spans}:
                break
            time.sleep(15)
        result["toolCalls"] = spans
        called = {s["tool"] for s in spans}
        if want:
            check(f"tools called ⊇ {sorted(want)}", want <= called, f"called {sorted(called)}")
        if "max_tool_errors" in exp:
            errs = sum(1 for s in spans if s["status"] != "OK")
            check(f"tool errors <= {exp['max_tool_errors']}", errs <= exp["max_tool_errors"],
                  f"{errs} error span(s)")
    result["orders"] = json.loads(json.dumps(rows, default=str))
    result["checks"] = checks
    return all(c["ok"] for c in checks) and result["status"] == "COMPLETED"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cases", nargs="*", help="case names (default: all)")
    ap.add_argument("--list", action="store_true", help="list available cases")
    args = ap.parse_args()

    available = sorted(p.stem for p in CASES_DIR.glob("*.json"))
    if args.list:
        print("\n".join(available))
        return 0
    names = args.cases or available

    env = load_env()
    session = env.session()
    connect, qconnect = session.client("connect"), session.client("qconnect")
    ddb = session.resource("dynamodb")
    run_dir = RUNS_DIR / datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir.mkdir(parents=True, exist_ok=True)

    failures = 0
    for name in names:
        case = json.loads((CASES_DIR / f"{name}.json").read_text(encoding="utf-8"))
        print(f"\n▶ {name}: {case.get('description', '')}")
        result = place_call(name, case, run_dir, env, connect, qconnect)
        print(f"  call {result['status']} in {result['durationSec']}s — verifying…")
        ok = verify(case, result, env, ddb, qconnect)
        for c in result["checks"]:
            print(f"  {'✔' if c['ok'] else '✘'} {c['check']}  {c['detail']}")
        for s in result.get("toolCalls", []):
            print(f"    tool {s['tool']:<16} {s['status']}")
        (run_dir / f"{name}.result.json").write_text(json.dumps(result, indent=2, default=str))
        print(f"  {'PASS' if ok else 'FAIL'}  (log: {run_dir / (name + '.result.json')})")
        failures += 0 if ok else 1
    print(f"\n{len(names) - failures}/{len(names)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
