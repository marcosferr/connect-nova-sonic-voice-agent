#!/usr/bin/env python3
"""List the tool calls the orchestrator AI agent actually made on one or more calls.

The authoritative source is the Q in Connect ListSpans API (one trace per
Q in Connect session). For each `execute_tool` span it prints the model's
toolUse (name + arguments), the execution status (OK / ERROR) and, when it
failed, the statusDescription (e.g. "MCP client failure: ... Target entity not
found"). This distinguishes "the model never called the tool" from "the model
called it but execution failed", which gateway or Lambda logs alone cannot.

It also decodes the business result of the tool when it is JSON, so a
`create_order` call that ran fine but returned
`{"status": "error", "code": "PIZZA_NOT_ON_MENU", ...}` is flagged as a
business error rather than counted as a success.

Input resolution:
  --session <uuid>     trace exactly that Q in Connect session
  --contact <id>       resolve the session from the Connect contact
                       (DescribeContact -> WisdomInfo.SessionArn)
  --since <minutes>    every contact in the window (SearchContacts), default 60

Add --corroborate to also report, for the window, the AgentCore tools/call
CloudWatch metric and the invocation count of each tool Lambda
(<project>-<tool-slug>-<env>) - independent signals that a call truly
reached the gateway and the backend.

IDs come from CloudFormation outputs via scripts/stack_env.py (env vars
AWS_PROFILE, AWS_REGION, PROJECT_NAME, ENV_NAME). Read-only.

Examples:
  python scripts/list-tool-calls.py --since 90 --corroborate
  python scripts/list-tool-calls.py --contact <contactId>
  python scripts/list-tool-calls.py --session <sessionId> --json
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from stack_env import load_env  # noqa: E402

TOOL_SLUGS = ["validate-customer", "get-menu", "create-order"]


class Tracer:
    def __init__(self, env):
        self.env = env
        s = env.session()
        self.qc = s.client("qconnect")
        self.connect = s.client("connect")
        self.logs = s.client("logs")
        self.cw = s.client("cloudwatch")

    # ---------- session discovery ----------
    def session_for_contact(self, contact_id: str) -> str | None:
        c = self.connect.describe_contact(InstanceId=self.env.instance_id, ContactId=contact_id)["Contact"]
        arn = (c.get("WisdomInfo") or {}).get("SessionArn") or ""
        return arn.rsplit("/", 1)[-1] if arn else None

    def contacts_in_window(self, minutes: int) -> list[str]:
        end = dt.datetime.now(dt.timezone.utc)
        start = end - dt.timedelta(minutes=minutes)
        ids, tok = [], None
        while True:
            kw = dict(
                InstanceId=self.env.instance_id,
                TimeRange={"Type": "INITIATION_TIMESTAMP", "StartTime": start, "EndTime": end},
                SearchCriteria={"Channels": ["VOICE"]},
                Sort={"FieldName": "INITIATION_TIMESTAMP", "Order": "DESCENDING"},
                MaxResults=100,
            )
            if tok:
                kw["NextToken"] = tok
            r = self.connect.search_contacts(**kw)
            ids.extend(c["Id"] for c in r.get("Contacts", []))
            tok = r.get("NextToken")
            if not tok:
                return ids

    # ---------- spans ----------
    def spans(self, session_id: str) -> list[dict]:
        out, tok = [], None
        while True:
            kw = dict(assistantId=self.env.assistant_id, sessionId=session_id)
            if tok:
                kw["nextToken"] = tok
            r = self.qc.list_spans(**kw)
            out.extend(r.get("spans", []))
            tok = r.get("nextToken")
            if not tok:
                return out


def _tooluse(span):
    attrs = span.get("attributes") or {}
    for m in attrs.get("inputMessages") or []:
        for v in m.get("values") or []:
            tu = v.get("toolUse")
            if tu:
                return tu.get("name"), tu.get("arguments")
    return None, None


def _toolresult(span):
    attrs = span.get("attributes") or {}
    for m in attrs.get("outputMessages") or []:
        for v in m.get("values") or []:
            tr = v.get("toolResult")
            if tr:
                for rv in tr.get("values") or []:
                    t = (rv.get("text") or {}).get("value")
                    if t:
                        return t
    return None


def short_tool(name: str | None) -> str:
    """`gateway_<id>__create-order___create_order` -> `create_order`."""
    return (name or "?").split("___")[-1]


def business_status(result_text: str | None):
    """Return (status, code) from a JSON tool result, if it has one."""
    if not result_text:
        return None, None
    try:
        body = json.loads(result_text)
    except (ValueError, TypeError):
        return None, None
    if isinstance(body, dict):
        return body.get("status"), body.get("code")
    return None, None


def report_session(tr: Tracer, session_id: str, contact: str = "", as_json=False):
    try:
        spans = tr.spans(session_id)
    except tr.qc.exceptions.ResourceNotFoundException:
        if not as_json:
            print(f"\n* session {session_id}  (contact {contact or '-'})  -- EXPIRED / no trace")
        return {"session": session_id, "contact": contact, "expired": True}
    tool_spans = sorted((s for s in spans if s.get("spanName") == "execute_tool"),
                        key=lambda s: str(s.get("startTimestamp", "")))
    escalated = any(s.get("spanName") == "escalate_agent" for s in spans)
    calls = []
    for s in tool_spans:
        name, args = _tooluse(s)
        result = _toolresult(s)
        bstatus, bcode = business_status(result)
        raw = s.get("startTimestamp")
        ts = raw.strftime("%H:%M:%S") if hasattr(raw, "strftime") else str(raw or "")[11:19]
        calls.append({
            "time": ts, "tool": name, "short": short_tool(name), "args": args,
            "status": s.get("status", "?"), "detail": s.get("statusDescription"),
            "result": result, "businessStatus": bstatus, "businessCode": bcode,
        })
    nerr = sum(1 for c in calls if c["status"] != "OK")
    nbiz = sum(1 for c in calls if c["status"] == "OK" and c["businessStatus"] == "error")
    summary = {"session": session_id, "contact": contact, "calls": len(calls),
               "errors": nerr, "businessErrors": nbiz, "escalated": escalated,
               "toolCalls": calls}
    if as_json:
        return summary

    print(f"\n* session {session_id}  (contact {contact or '-'})  -- {len(calls)} tool call(s): "
          f"{len(calls) - nerr - nbiz} ok / {nerr} exec-error / {nbiz} business-error"
          f"{'  + escalated' if escalated else ''}")
    if not calls:
        print("    (no execute_tool spans - the model never called a tool in this session)")
    for c in calls:
        if c["status"] != "OK":
            mark = "ERR"
        elif c["businessStatus"] == "error":
            mark = "BIZ"
        else:
            mark = "OK "
        print(f"    [{mark}] {c['time']}  {c['tool']}  args={c['args']}")
        if c["status"] != "OK":
            print(f"           -> {str(c['detail'] or c['result'] or '(no detail)')[:240]}")
        elif c["businessStatus"]:
            extra = f" code={c['businessCode']}" if c["businessCode"] else ""
            print(f"           -> status={c['businessStatus']}{extra}")
    return summary


def corroborate(tr: Tracer, minutes: int, gateway_log_group: str | None):
    start_ms = int((time.time() - minutes * 60) * 1000)
    print(f"\n-- corroboration (last {minutes}m) --")
    try:
        end = dt.datetime.now(dt.timezone.utc)
        r = tr.cw.get_metric_statistics(
            Namespace="AWS/Bedrock-AgentCore", MetricName="Invocations",
            Dimensions=[{"Name": "Method", "Value": "tools/call"}],
            StartTime=end - dt.timedelta(minutes=minutes), EndTime=end,
            Period=max(60, minutes * 60), Statistics=["Sum"])
        total = sum(d["Sum"] for d in r.get("Datapoints", []))
        print(f"  CW metric AWS/Bedrock-AgentCore Invocations Method=tools/call = {int(total)}")
    except Exception as e:  # noqa: BLE001 - corroboration is best-effort
        print(f"  CW metric: (unavailable: {str(e)[:80]})")

    if gateway_log_group:
        counts = {"tools/call": 0, "tools/list": 0}
        try:
            tok = None
            while True:
                kw = dict(logGroupName=gateway_log_group, startTime=start_ms)
                if tok:
                    kw["nextToken"] = tok
                r = tr.logs.filter_log_events(**kw)
                for e in r.get("events", []):
                    for k in counts:
                        if k in e.get("message", ""):
                            counts[k] += 1
                tok = r.get("nextToken")
                if not tok:
                    break
            print(f"  gateway log: tools/call={counts['tools/call']}  tools/list={counts['tools/list']}")
        except Exception as e:  # noqa: BLE001
            print(f"  gateway log: (unavailable: {str(e)[:80]})")

    for slug in TOOL_SLUGS:
        fn = f"{tr.env.project}-{slug}-{tr.env.env_name}"
        try:
            n, tok = 0, None
            while True:
                kw = dict(logGroupName=f"/aws/lambda/{fn}", startTime=start_ms,
                          filterPattern='"REPORT RequestId"')
                if tok:
                    kw["nextToken"] = tok
                r = tr.logs.filter_log_events(**kw)
                n += len(r.get("events", []))
                tok = r.get("nextToken")
                if not tok:
                    break
            print(f"  lambda {fn}: {n} invocation(s)")
        except tr.logs.exceptions.ResourceNotFoundException:
            print(f"  lambda {fn}: (no log group yet)")
        except Exception as e:  # noqa: BLE001
            print(f"  lambda {fn}: (unavailable: {str(e)[:80]})")


def main():
    ap = argparse.ArgumentParser(
        description="List the MCP tool calls the orchestrator AI agent made (Q in Connect ListSpans).")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--session", help="trace one Q in Connect session id")
    g.add_argument("--contact", help="trace the session of one Connect contact id")
    ap.add_argument("--since", type=int, default=60, help="window in minutes when neither --session "
                    "nor --contact is given; also the corroboration window (default 60)")
    ap.add_argument("--corroborate", action="store_true",
                    help="also report the AgentCore tools/call metric and tool-Lambda invocations")
    ap.add_argument("--gateway-log-group", help="optional AgentCore gateway log group to count "
                    "tools/call vs tools/list lines (only if gateway logging is enabled)")
    ap.add_argument("--json", action="store_true", help="emit machine-readable JSON instead of text")
    a = ap.parse_args()

    tr = Tracer(load_env())

    targets: list[tuple[str, str]] = []
    if a.session:
        targets.append((a.session, ""))
    else:
        contacts = [a.contact] if a.contact else tr.contacts_in_window(a.since)
        if not contacts and not a.json:
            print(f"No voice contacts found in the last {a.since} minutes.")
        for cid in contacts:
            sid = tr.session_for_contact(cid)
            if sid:
                targets.append((sid, cid))
            elif a.contact and not a.json:
                print(f"Contact {cid} has no Q in Connect session (hang-up before the bot?).")

    seen, summaries = set(), []
    for sid, cid in targets:
        if sid in seen:
            continue
        seen.add(sid)
        summaries.append(report_session(tr, sid, cid, as_json=a.json))

    if a.json:
        print(json.dumps(summaries, indent=2, default=str, ensure_ascii=False))
        return

    live = [s for s in summaries if not s.get("expired")]
    if live:
        tot = sum(s["calls"] for s in live)
        err = sum(s["errors"] for s in live)
        biz = sum(s["businessErrors"] for s in live)
        esc = sum(1 for s in live if s["escalated"])
        print(f"\n= {len(live)} session(s): {tot} tool call(s), {err} exec-failed, "
              f"{biz} business-error, {esc} escalated =")
        if err:
            print("  (exec failures usually share one cause - see the -> lines; "
                  "'Target entity not found' = the agent's MCP toolId does not match the gateway)")

    if a.corroborate:
        corroborate(tr, a.since, a.gateway_log_group)


if __name__ == "__main__":
    main()
