#!/usr/bin/env bash
# Independent QA for the equipment inspection record service (plan: ../tasks-qa.md).
# Runs in an empty writable working directory; uses only bash + python3 stdlib.
# Tokens are read from AIDH_SECRET_* env vars and are never written to results/evidence.
set -uo pipefail

: "${QA_RESULT_PATH:?QA_RESULT_PATH is required}"
: "${QA_EVIDENCE_DIR:?QA_EVIDENCE_DIR is required}"
mkdir -p "$QA_EVIDENCE_DIR"

cat > ./qa_main.py <<'PYEOF'
import json, os, re, sys, time, random, string, ssl, datetime, traceback
import urllib.request, urllib.error, urllib.parse

EVD = os.environ["QA_EVIDENCE_DIR"]
RESULT_PATH = os.environ["QA_RESULT_PATH"]
SHA = os.environ.get("QA_CANDIDATE_SHA", "")
STATE_DIR = os.environ.get("QA_STATE_DIR", "")


def _int(v, d):
    m = re.match(r"\s*(\d+)", v or "")
    return int(m.group(1)) if m else d


PHASES = _int(os.environ.get("QA_PHASES"), 1)
PHASE = _int(os.environ.get("QA_PHASE"), 1)
MULTI = PHASES >= 2 and bool(STATE_DIR)
FIRST = (not MULTI) or PHASE <= 1
LAST = (not MULTI) or PHASE >= PHASES


def sec(name):
    return os.environ.get("AIDH_SECRET_" + name, "").strip()


TOK = {
    "I1": sec("QA_INSPECTOR_1_TOKEN"),
    "I2": sec("QA_INSPECTOR_2_TOKEN"),
    "M1": sec("QA_MANAGER_TOKEN"),
    "X": sec("QA_INVALID_TOKEN") or "qa" + "".join(random.choice(string.ascii_letters + string.digits) for _ in range(46)),
}
HOLDER = {"I1": sec("QA_INSPECTOR_1_HOLDER"), "I2": sec("QA_INSPECTOR_2_HOLDER")}
LOG_URL = sec("QA_SERVICE_LOG_URL")
LOG_TOKEN = sec("QA_SERVICE_LOG_TOKEN")
MISSING_SECRETS = [n for n, k in (("QA_INSPECTOR_1_TOKEN", "I1"), ("QA_INSPECTOR_2_TOKEN", "I2"), ("QA_MANAGER_TOKEN", "M1")) if not TOK[k]]


def redact(text):
    if text is None:
        return None
    if not isinstance(text, str):
        text = json.dumps(text, ensure_ascii=False)
    for k in ("I1", "I2", "M1", "X"):
        if TOK[k]:
            text = text.replace(TOK[k], "<%s>" % k)
    if LOG_TOKEN:
        text = text.replace(LOG_TOKEN, "<LOGTOKEN>")
    return text


def tokens_in(text, keys):
    return [k for k in keys if TOK.get(k) and TOK[k] in (text or "")]


def pick_base():
    svc = {k: v for k, v in os.environ.items() if re.match(r"^AIDH_SERVICE_.+_URL$", k) and v.strip()}
    if not svc:
        return None, None
    pref = sorted(k for k in svc if "INSPECT" in k) or sorted(svc)
    return pref[0], svc[pref[0]].strip().rstrip("/")


SVC_VAR, BASE = pick_base()
SSL_CTX = ssl.create_default_context()  # certificate verification stays on


class Resp:
    def __init__(self, status, headers, body, error=None):
        self.status, self.headers, self.body, self.error = status, headers, body, error

    def json(self):
        try:
            return json.loads(self.body)
        except Exception:
            return None

    @property
    def ok(self):
        return self.status is not None and 200 <= self.status < 300

    def text_all(self):
        return (self.body or "") + "\n" + json.dumps(self.headers or {}, ensure_ascii=False)


LOGBOOK = []      # request log of the current scenario
ENV_ERRORS = []   # transport-level failures (DNS/TLS/connect/timeout)


def http(method, path, who=None, body=None, raw_auth=None, url=None, log=True):
    full = url or (BASE + path)
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    if raw_auth is not None:
        headers["Authorization"] = raw_auth
    elif who:
        headers["Authorization"] = "Bearer " + TOK[who]
    req = urllib.request.Request(full, data=data, method=method, headers=headers)
    status, rh, rb, err = None, {}, "", None
    try:
        with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as r:
            status, rh, rb = r.status, dict(r.headers.items()), r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        status, rh = e.code, (dict(e.headers.items()) if e.headers else {})
        try:
            rb = e.read().decode("utf-8", "replace")
        except Exception:
            rb = ""
    except Exception as e:
        err = "%s: %s" % (type(e).__name__, e)
    if log:
        LOGBOOK.append({
            "time": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "caller": who if raw_auth is None else "raw-auth", "method": method, "url": redact(full),
            "requestBody": redact(json.dumps(body, ensure_ascii=False)) if body is not None else None,
            "status": status, "responseHeaders": {k: redact(v) for k, v in rh.items()},
            "responseBody": redact(rb[:20000]), "error": redact(err),
        })
    if err:
        ENV_ERRORS.append(redact("%s %s -> %s" % (method, full, err)))
    return Resp(status, rh, rb, err)


def write_json(name, obj):
    with open(os.path.join(EVD, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)

def norm(k):
    return re.sub(r"[_\-\s.]", "", str(k).lower())


ROLE_TESTS = {
    "id": lambda n: n in ("id", "recordid", "inspectionid", "inspectionrecordid", "uuid"),
    "device": lambda n: any(s in n for s in ("device", "equipment", "asset")) and "name" not in n,
    "store": lambda n: any(s in n for s in ("store", "shop", "branch")) and "name" not in n,
    "conclusion": lambda n: n in ("result", "conclusion", "status", "outcome", "verdict", "inspectionresult",
                                  "inspectionconclusion", "resultstatus", "inspectionstatus", "conclusionstatus"),
    "remark": lambda n: any(s in n for s in ("remark", "note", "comment", "memo")),
    "inspector": lambda n: any(s in n for s in ("inspector", "submitter", "submittedby", "createdby", "holder",
                                                "operator", "reporter", "user")),
    "time": lambda n: n in ("submittedat", "createdat", "timestamp", "time", "inspectedat", "submittime",
                            "createtime", "recordedat", "submissiontime", "submittedtime", "receivedat"),
}
ROLE_ZH = {"device": ["设备"], "store": ["门店", "店"], "conclusion": ["结论", "结果"], "remark": ["备注"]}

API = {"submit": None, "query": None, "fields": {}, "values": {}, "source": None}
DISC = {"openapi": None, "steps": []}


def role_keys(rec, role):
    if not isinstance(rec, dict):
        return []
    pref = API["fields"].get(role)
    keys = [k for k in rec if pref and k == pref]
    keys += [k for k in rec if k not in keys and ROLE_TESTS[role](norm(k))]
    return keys


def rget(rec, role):
    for k in role_keys(rec, role):
        return rec[k]
    for v in (rec.values() if isinstance(rec, dict) else []):
        if isinstance(v, dict):
            for k in role_keys(v, role):
                return v[k]
    return None


def has_role(rec, role):
    if role_keys(rec, role):
        return True
    return any(isinstance(v, dict) and role_keys(v, role) for v in (rec.values() if isinstance(rec, dict) else []))


def sval(v):
    if v is None:
        return ""
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False, sort_keys=True)
    return str(v)


def meaning(v):
    s = sval(v).strip().lower()
    if s in ("异常",) or any(x in s for x in ("abnormal", "fault", "fail", "exception", "error", "异常")):
        return "A"
    if s in ("正常",) or any(x in s for x in ("normal", "ok", "pass", "正常")):
        return "N"
    return "?"


def records_of(resp):
    j = resp.json()
    if isinstance(j, list):
        return j
    if isinstance(j, dict):
        for k in ("records", "items", "data", "inspections", "results", "list", "content"):
            if isinstance(j.get(k), list):
                return j[k]
            if isinstance(j.get(k), dict):
                for kk in ("records", "items", "list"):
                    if isinstance(j[k].get(kk), list):
                        return j[k][kk]
        for v in j.values():
            if isinstance(v, list):
                return v
    return None


def record_id_from(resp):
    j = resp.json()
    cands = [j] if isinstance(j, dict) else []
    if isinstance(j, dict):
        cands += [j[k] for k in ("data", "record", "result", "inspection") if isinstance(j.get(k), dict)]
    for c in cands:
        for k in c:
            if ROLE_TESTS["id"](norm(k)) and c[k] not in (None, ""):
                return sval(c[k])
    loc = {k.lower(): v for k, v in (resp.headers or {}).items()}.get("location")
    if loc:
        return loc.rstrip("/").split("/")[-1]
    return None


def parse_time(v):
    if v is None:
        return None
    if isinstance(v, (int, float)) or re.fullmatch(r"\d{9,14}(\.\d+)?", str(v)):
        x = float(v)
        return x / 1000.0 if x > 1e11 else x
    s = str(v).strip().replace(" ", "T", 1)
    s = re.sub(r"Z$", "+00:00", s)
    s = re.sub(r"(\.\d{6})\d+", r"\1", s)
    try:
        d = datetime.datetime.fromisoformat(s)
    except Exception:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=datetime.timezone.utc)
    return d.timestamp()


def mentions(resp, role):
    body = (resp.body or "").lower()
    names = set(ROLE_ZH.get(role, []))
    if API["fields"].get(role):
        names.add(API["fields"][role])
    names |= {"device", "deviceid", "device_id"} if role == "device" else set()
    names |= {"store", "storeid", "store_id", "shop"} if role == "store" else set()
    names |= {"result", "conclusion"} if role == "conclusion" else set()
    flat = re.sub(r"[_\-]", "", body)
    return any(n.lower() in body or norm(n) in flat for n in names)


def submit_body(device=None, store=None, concl=None, remark=None, extra=None, omit=()):
    f, b = API["fields"], {}
    for role, val in (("device", device), ("store", store), ("conclusion", concl), ("remark", remark)):
        if role in omit or val is None or not f.get(role):
            continue
        b[f[role]] = API["values"].get(val, val) if role == "conclusion" else val
    b.update(extra or {})
    return b


def submit_path(device):
    t = API["submit"]
    return t.replace("{d}", urllib.parse.quote(device, safe="")) if "{d}" in t else t


def query(who, device, raw_auth=None):
    return http("GET", API["query"].replace("{d}", urllib.parse.quote(device, safe="")), who=who, raw_auth=raw_auth)


OPENAPI_PATHS = ["/openapi.json", "/swagger.json", "/v3/api-docs", "/api/openapi.json", "/docs/openapi.json",
                 "/api-docs", "/swagger/v1/swagger.json", "/api/swagger.json"]
SUBMIT_PATHS = ["/inspections", "/inspection-records", "/api/inspections", "/api/v1/inspections",
                "/api/inspection-records", "/api/v1/inspection-records", "/v1/inspections", "/records",
                "/api/records", "/devices/{d}/inspections", "/api/devices/{d}/inspections",
                "/api/v1/devices/{d}/inspections"]
QUERY_PATHS = ["/devices/{d}/inspections", "/devices/{d}/inspection-records", "/api/devices/{d}/inspections",
               "/api/v1/devices/{d}/inspections", "/devices/{d}/records", "/api/devices/{d}/inspection-records",
               "/api/v1/devices/{d}/inspection-records", "/inspections?deviceId={d}", "/inspections?device_id={d}",
               "/inspection-records?deviceId={d}", "/api/inspections?deviceId={d}",
               "/api/v1/inspections?deviceId={d}", "/api/inspection-records?deviceId={d}", "/equipment/{d}/inspections",
               "/inspections/{d}", "/api/inspections/{d}"]
FIELD_SETS = [(d, s, c, r) for d, s in (("deviceId", "storeId"), ("device_id", "store_id"), ("deviceId", "shopId"),
                                         ("equipmentId", "storeId"), ("device", "store"))
              for c in ("result", "conclusion", "status", "inspectionResult")
              for r in ("remark", "note", "notes", "comment")]
VALUE_SETS = [("正常", "异常"), ("NORMAL", "ABNORMAL"), ("normal", "abnormal"), ("OK", "ABNORMAL")]


def deref(doc, s, depth=0):
    if not isinstance(s, dict) or depth > 8:
        return {}
    if "$ref" in s:
        node = doc
        for part in s["$ref"].lstrip("#/").split("/"):
            node = node.get(part, {}) if isinstance(node, dict) else {}
        return deref(doc, node, depth + 1)
    if "allOf" in s:
        out = {"properties": {}, "required": []}
        for sub in s["allOf"]:
            r = deref(doc, sub, depth + 1)
            out["properties"].update(r.get("properties", {}))
            out["required"] += r.get("required", [])
        return out
    return s


def from_openapi():
    doc = None
    for p in OPENAPI_PATHS:
        r = http("GET", p, who="M1", log=False)
        j = r.json() if r.ok else None
        if isinstance(j, dict) and isinstance(j.get("paths"), dict):
            doc, DISC["openapi"] = j, p
            break
    if not doc:
        return
    subs, qs = [], []
    for path, ops in doc["paths"].items():
        if not isinstance(ops, dict):
            continue
        for m, op in ops.items():
            if not isinstance(op, dict):
                continue
            text = (path + " " + str(op.get("summary", "")) + " " + str(op.get("operationId", "")) + " " +
                    str(op.get("description", ""))).lower()
            if not re.search(r"inspect|record|巡检", text):
                continue
            params = (ops.get("parameters") or []) + (op.get("parameters") or [])
            params = [deref(doc, p) for p in params]
            pparams = re.findall(r"\{([^}]+)\}", path)
            if m == "post":
                schema = {}
                content = deref(doc, op.get("requestBody", {})).get("content", {})
                for ct, c in content.items():
                    schema = deref(doc, c.get("schema", {}))
                    break
                if not schema:
                    for p in params:
                        if p.get("in") == "body":
                            schema = deref(doc, p.get("schema", {}))
                tpl = path
                if pparams:
                    if len(pparams) != 1 or not ROLE_TESTS["device"](norm(pparams[0])):
                        continue
                    tpl = path.replace("{%s}" % pparams[0], "{d}")
                subs.append((tpl, schema))
            elif m == "get":
                if pparams and len(pparams) == 1 and ROLE_TESTS["device"](norm(pparams[0])):
                    qs.append(path.replace("{%s}" % pparams[0], "{d}"))
                elif pparams and len(pparams) == 1 and "/devices/" in path:
                    qs.append(path.replace("{%s}" % pparams[0], "{d}"))
                elif not pparams:
                    for p in params:
                        if p.get("in") == "query" and ROLE_TESTS["device"](norm(p.get("name", ""))):
                            qs.append("%s?%s={d}" % (path, p["name"]))
    DISC["steps"].append({"openapiSubmitCandidates": [s[0] for s in subs], "openapiQueryCandidates": qs})
    if subs:
        tpl, schema = subs[0]
        props = schema.get("properties", {}) if isinstance(schema, dict) else {}
        f = {}
        for name, ps in props.items():
            for role in ("device", "store", "remark", "conclusion"):
                if role not in f and ROLE_TESTS[role](norm(name)):
                    f[role] = name
                    if role == "conclusion":
                        enum = deref(doc, ps).get("enum") or []
                        n = [e for e in enum if meaning(e) == "N"]
                        a = [e for e in enum if meaning(e) == "A"]
                        if n and a:
                            API["values"] = {"正常": n[0], "异常": a[0]}
                    break
        API["openapiSubmit"] = (tpl, f)
    API["openapiQuery"] = qs


def discover(probe_dev, store):
    from_openapi()
    # query endpoint: M1 querying a never-used device must give a 2xx list
    qcands = (API.get("openapiQuery") or []) + [q for q in QUERY_PATHS if q not in (API.get("openapiQuery") or [])]
    for q in qcands:
        r = http("GET", q.replace("{d}", urllib.parse.quote(probe_dev, safe="")), who="M1")
        DISC["steps"].append({"queryProbe": q, "status": r.status})
        if r.error:
            return
        if r.ok and records_of(r) is not None:
            API["query"] = q
            break
    if not API["query"]:
        return
    # submit endpoint + field names: accepted AND remark visible on query
    combos = []
    if API.get("openapiSubmit"):
        tpl, f = API["openapiSubmit"]
        if f.get("conclusion") and (f.get("device") or "{d}" in tpl):
            vals = [(API["values"]["正常"], API["values"]["异常"])] if API["values"] else VALUE_SETS
            combos.append((tpl, (f.get("device"), f.get("store"), f.get("conclusion"), f.get("remark", "remark")), vals))
    for p in SUBMIT_PATHS:
        combos.append((p, None, VALUE_SETS))
    dead = set()
    n = 0
    for tpl, fs, vals in combos:
        for fset in ([fs] if fs else FIELD_SETS):
            if tpl in dead:
                break
            for nv, av in vals:
                n += 1
                if n > 400:
                    return
                marker = "%s-probe%d" % (probe_dev, n)
                fd, fsr, fc, fr = fset
                body = {fsr: store, fc: nv, fr: marker}
                if "{d}" not in tpl:
                    body[fd] = probe_dev
                path = tpl.replace("{d}", urllib.parse.quote(probe_dev, safe=""))
                r = http("POST", path, who="I1", body=body)
                DISC["steps"].append({"submitProbe": tpl, "fields": fset, "value": nv, "status": r.status})
                if r.error:
                    return
                if r.status in (404, 405, 501):
                    dead.add(tpl)
                    break
                if not r.ok:
                    continue
                q = http("GET", API["query"].replace("{d}", urllib.parse.quote(probe_dev, safe="")), who="M1")
                hit = [x for x in (records_of(q) or []) if marker in json.dumps(x, ensure_ascii=False)]
                if hit:
                    API["submit"] = tpl
                    API["fields"] = {"device": fd if "{d}" not in tpl else None, "store": fsr, "conclusion": fc, "remark": fr}
                    API["source"] = "openapi" if fs else "probing"
                    API["values"] = {"正常": nv, "异常": av}
                    for cand in [av] + [v[1] for v in VALUE_SETS if v[1] != av]:
                        b2 = dict(body)
                        b2[fc], b2[fr] = cand, marker + "-a"
                        r2 = http("POST", path, who="I1", body=b2)
                        DISC["steps"].append({"abnormalValueProbe": cand, "status": r2.status})
                        if r2.ok:
                            API["values"]["异常"] = cand
                            break
                    return
                break  # accepted but remark not visible -> try next field set


def submit(who, device, store, concl, remark=None, extra=None, omit=(), raw_auth=None):
    pd = " " if "device" in omit else device
    return http("POST", submit_path(pd), who=who, raw_auth=raw_auth,
                body=submit_body(device, store, concl, remark, extra, omit))


# ---------------- scenario framework ----------------
RESULTS = {}
ENV_NOTES = []     # environment/platform observations (A-12, A-13)
LATE_CHECKS = []   # (scenario id, marker) that must never appear in any query
FAIL_TOKEN_CHECKS = []  # (scenario, label, token codes found in a failure response)
SAVED = {}         # query results saved before the redeploy
RUN = None


def is_input(r):
    return r.status in (400, 422)


def brief(r):
    if r.error:
        return "transport error: " + redact(r.error)
    return "HTTP %s %s" % (r.status, redact((r.body or "")[:300]))


class Sc:
    def __init__(self, sid, tag="", assumptions=None):
        self.sid, self.tag, self.cps = sid, tag, []
        self.assumptions = list(assumptions or [])
        del LOGBOOK[:]

    def cp(self, step, ok, obs, kind="defect"):
        self.cps.append({"step": step, "passed": bool(ok), "observation": redact(str(obs))[:1500],
                         "kind": None if ok else kind})
        return bool(ok)

    def done(self):
        fname = "%s%s.json" % (self.sid, self.tag)
        write_json(fname, {"scenario": self.sid, "phase": PHASE, "assumptions": self.assumptions,
                           "checkpoints": self.cps, "requests": list(LOGBOOK)})
        prev = RESULTS.get(self.sid)
        if prev:
            prev["checkpoints"] += self.cps
            prev["evidence"].append(fname)
            prev["assumptions"] += [a for a in self.assumptions if a not in prev["assumptions"]]
        else:
            RESULTS[self.sid] = {"id": self.sid, "checkpoints": list(self.cps), "evidence": [fname],
                                 "assumptions": self.assumptions}


BASE_ASSUME = ["A-1..A-7: 接口路径/字段/状态码按测试计划 tasks-qa.md 第 3 节推定"]


def dev(n):
    return "%s-D%d" % (RUN, n)


def q_records(device):
    r = query("M1", device)
    return r, records_of(r) if r.ok else None


def expect_empty(sc, step, device, markers=()):
    r, recs = q_records(device)
    leaked = [m for m in markers if m in (r.body or "")]
    return sc.cp(step, r.ok and recs == [] and not leaked,
                 "M1 查询 %s: %s; 记录数=%s" % (device, "HTTP %s" % r.status, None if recs is None else len(recs)))


INSP = {"I1": None, "I2": None}


def inspector_ok(who, v):
    s = sval(v)
    if not s.strip() or tokens_in(s, ["I1", "I2", "M1", "X"]):
        return False, "巡检员字段为空或含令牌"
    if HOLDER.get(who):
        return (HOLDER[who] == s or HOLDER[who] in s), "巡检员=%s 期望持有人=%s" % (s, HOLDER[who])
    if INSP[who] is None:
        INSP[who] = s
    other = "I2" if who == "I1" else "I1"
    good = s == INSP[who] and (INSP[other] is None or INSP[other] != s) and "FAKE" not in s
    return good, "巡检员=%s（A-10：与该令牌此前记录一致=%s）" % (s, s == INSP[who])


def one_record(sc, step, device, n=1):
    r, recs = q_records(device)
    sc.cp(step, r.ok and recs is not None and len(recs) == n,
          "M1 查询 %s: HTTP %s, 记录数=%s（期望 %d）" % (device, r.status, None if recs is None else len(recs), n))
    return recs or []


# ---------------- phase 1 ----------------
def phase1():
    S1, S2 = RUN + "-S1", RUN + "-S2"
    R = lambda n: "%s-R%s-备注" % (RUN, n)

    sc = Sc("IQA-001", assumptions=BASE_ASSUME + ["A-10"])
    r = submit("I1", dev(1), S1, "异常", R(1))
    rid = record_id_from(r)
    sc.cp("I1 提交 D1 被接受并返回记录标识", r.ok and rid, brief(r) + " recordId=%s" % rid)
    recs = one_record(sc, "M1 查询 D1 恰好 1 条", dev(1))
    if recs:
        x = recs[0]
        sc.cp("字段：设备/门店/结论/备注", sval(rget(x, "device")) == dev(1) and sval(rget(x, "store")) == S1 and
              meaning(rget(x, "conclusion")) == "A" and sval(rget(x, "remark")) == R(1), json.dumps(x, ensure_ascii=False))
        sc.cp("记录标识与提交返回值一致", rid is not None and sval(rget(x, "id")) == rid, "query id=%s submit id=%s" % (rget(x, "id"), rid))
        ok, obs = inspector_ok("I1", rget(x, "inspector"))
        sc.cp("巡检员为 I1", ok, obs)
    sc.done()

    sc = Sc("IQA-002", assumptions=BASE_ASSUME)
    r = submit("I1", dev(2), S1, "正常", None)
    sc.cp("I1 提交 D2（无备注）被接受", r.ok, brief(r))
    recs = one_record(sc, "M1 查询 D2 恰好 1 条", dev(2))
    if recs:
        x = recs[0]
        sc.cp("结论=正常", meaning(rget(x, "conclusion")) == "N", sval(rget(x, "conclusion")))
        sc.cp("备注为空", sval(rget(x, "remark")).strip() == "", "remark=%r" % rget(x, "remark"))
    sc.done()

    sc = Sc("IQA-003", assumptions=BASE_ASSUME + ["A-8", "A-10"])
    t0 = time.time()
    fake = {"inspector": RUN + "-FAKE-I2", "submittedBy": RUN + "-FAKE-I2", "inspectorName": RUN + "-FAKE-I2",
            "submittedAt": "2000-01-01T00:00:00Z", "createdAt": "2000-01-01T00:00:00Z", "time": "2000-01-01T00:00:00Z"}
    r = submit("I1", dev(3), S1, "正常", R(3), extra=fake)
    t1 = time.time()
    sc.cp("携带伪造巡检员与时间的提交被接受", r.ok, brief(r))
    recs = one_record(sc, "M1 查询 D3 恰好 1 条", dev(3))
    if recs:
        x = recs[0]
        ok, obs = inspector_ok("I1", rget(x, "inspector"))
        sc.cp("巡检员不是伪造名且为 I1", ok and "FAKE" not in sval(rget(x, "inspector")), obs)
        ts = parse_time(rget(x, "time"))
        sc.cp("提交时间为服务接收时间", ts is not None and t0 - 120 <= ts <= t1 + 120,
              "time=%s T0=%.0f T1=%.0f" % (sval(rget(x, "time")), t0, t1))
    sc.done()

    sc = Sc("IQA-004", assumptions=BASE_ASSUME + ["A-8"])
    ra = submit("I1", dev(4), S1, "正常", R("4a"))
    time.sleep(1.2)
    rb = submit("I2", dev(4), S1, "异常", R("4b"))
    sc.cp("I1、I2 两次提交都被接受", ra.ok and rb.ok, brief(ra) + " | " + brief(rb))
    if rb.status == 401:
        ENV_NOTES.append("阶段 1 中 I2 被拒绝为未识别身份：I2 可能已提前从机密配置删除（A-12）")
    recs = one_record(sc, "M1 查询 D4 恰好 2 条", dev(4), 2)
    if len(recs) == 2:
        missing = [(i, role) for i, x in enumerate(recs) for role in ("id", "device", "store", "conclusion", "remark", "inspector", "time")
                   if not has_role(x, role)]
        sc.cp("每条包含 7 项字段（备注可为空）", not missing, "缺少: %s" % missing)
        sc.cp("从新到旧：第 1 条为 I2 异常，第 2 条为 I1 正常",
              meaning(rget(recs[0], "conclusion")) == "A" and sval(rget(recs[0], "remark")) == R("4b") and
              meaning(rget(recs[1], "conclusion")) == "N" and sval(rget(recs[1], "remark")) == R("4a"),
              [sval(rget(x, "remark")) for x in recs])
        i1v = [x for x in recs if sval(rget(x, "remark")) == R("4a")]
        i2v = [x for x in recs if sval(rget(x, "remark")) == R("4b")]
        if i1v and i2v:
            ok1, o1 = inspector_ok("I1", rget(i1v[0], "inspector"))
            if INSP["I2"] is None and not HOLDER["I2"]:
                INSP["I2"] = sval(rget(i2v[0], "inspector"))
            ok2, o2 = inspector_ok("I2", rget(i2v[0], "inspector"))
            sc.cp("两条记录的巡检员分别为 I1、I2 且不同", ok1 and ok2 and
                  sval(rget(i1v[0], "inspector")) != sval(rget(i2v[0], "inspector")), o1 + " | " + o2)
    sc.done()

    sc = Sc("IQA-005", assumptions=BASE_ASSUME)
    r1 = submit("I1", dev(5), S1, "正常", R("5a"))
    qa, first = q_records(dev(5))
    time.sleep(1.1)
    r2 = submit("I1", dev(5), S1, "异常", R("5b"))
    time.sleep(1.1)
    r3 = submit("I1", dev(5), S1, "异常", R("5b"))
    sc.cp("三次提交都被接受", r1.ok and r2.ok and r3.ok, " | ".join(brief(x) for x in (r1, r2, r3)))
    qb, final = q_records(dev(5))
    ids = [sval(rget(x, "id")) for x in (final or [])]
    sc.cp("最终 3 条且记录标识互不相同", final is not None and len(final) == 3 and len(set(ids)) == 3, "ids=%s" % ids)
    if first and final:
        f0 = json.dumps(first[0], sort_keys=True, ensure_ascii=False)
        same = [x for x in final if json.dumps(x, sort_keys=True, ensure_ascii=False) == f0]
        sc.cp("第 1 次记录的全部字段未被改变", len(first) == 1 and len(same) == 1, "first=%s" % f0)
    else:
        sc.cp("第 1 次记录的全部字段未被改变", False, "第一次查询结果不可用: " + brief(qa))
    sc.done()

    sc = Sc("IQA-006", assumptions=BASE_ASSUME)
    rs = [submit("I1", dev(6), S1, "正常", R("6a")), submit("I1", dev(6), S1, "异常", R("6b")),
          submit("I1", dev(7), S1, "正常", R(7))]
    sc.cp("前置：D6 两条、D7 一条提交被接受", all(x.ok for x in rs), " | ".join(brief(x) for x in rs))
    r, recs = q_records(dev(6))
    sc.cp("只凭设备标识查询 D6 成功且恰好 2 条", r.ok and recs is not None and len(recs) == 2, brief(r))
    sc.cp("每条设备=D6，且不含 D7 记录", recs is not None and all(sval(rget(x, "device")) == dev(6) for x in recs)
          and R(7) not in (r.body or "") and dev(7) not in (r.body or ""), "devices=%s" % [sval(rget(x, "device")) for x in (recs or [])])
    sc.done()

    sc = Sc("IQA-007", assumptions=BASE_ASSUME)
    r, recs = q_records(dev(8))
    sc.cp("查询从未提交过的 D8 返回成功", r.ok, brief(r))
    sc.cp("记录列表为空", recs == [], "records=%s" % recs)
    sc.done()

    sc = Sc("IQA-008", assumptions=BASE_ASSUME + ["A-9"])
    ra = submit("I1", None, S1, "正常", R(8), omit=("device",))
    rb = submit("I1", "   ", S1, "正常", R(8))
    for lab, x in (("缺少设备标识", ra), ("设备标识为空白", rb)):
        sc.cp(lab + "：被拒绝为输入不符合要求", is_input(x), brief(x))
        sc.cp(lab + "：指明设备标识", is_input(x) and mentions(x, "device"), brief(x))
    sc.done()
    LATE_CHECKS.append(("IQA-008", R(8)))

    sc = Sc("IQA-009", assumptions=BASE_ASSUME)
    ra = submit("I1", dev(9), S1, None, R(9), omit=("conclusion",))
    rb = submit("I1", dev(9), S1, "", R(9))
    for lab, x in (("缺少巡检结论", ra), ("结论为空串", rb)):
        sc.cp(lab + "：被拒绝为输入不符合要求", is_input(x), brief(x))
        sc.cp(lab + "：指明巡检结论", is_input(x) and mentions(x, "conclusion"), brief(x))
    expect_empty(sc, "M1 查询 D9 为空", dev(9), [R(9)])
    sc.done()

    sc = Sc("IQA-010", assumptions=BASE_ASSUME)
    ra = submit("I1", dev(10), None, "正常", R(10), omit=("store",))
    rb = submit("I1", dev(10), "", "正常", R(10))
    rc = submit("I1", dev(11), S1, "良好", R(11))
    for lab, x, role in (("缺少门店", ra, "store"), ("门店为空串", rb, "store"), ("结论为“良好”", rc, "conclusion")):
        sc.cp(lab + "：被拒绝为输入不符合要求", is_input(x), brief(x))
        sc.cp(lab + "：指明" + ("门店标识" if role == "store" else "巡检结论"), is_input(x) and mentions(x, role), brief(x))
    expect_empty(sc, "M1 查询 D10 为空", dev(10), [R(10)])
    expect_empty(sc, "M1 查询 D11 为空", dev(11), [R(11)])
    sc.done()

    sc = Sc("IQA-011", assumptions=BASE_ASSUME)
    rs = [("不带令牌", submit(None, dev(12), S1, "正常", R(12))),
          ("无效令牌 X", submit("X", dev(12), S1, "正常", R(12))),
          ("空 Bearer", submit(None, dev(12), S1, "正常", R(12), raw_auth="Bearer "))]
    for lab, x in rs:
        sc.cp(lab + " 提交被拒绝为未识别身份(401)", x.status == 401, brief(x))
        FAIL_TOKEN_CHECKS.append(("IQA-011", lab, tokens_in(x.text_all(), ["X", "I1", "I2", "M1"])))
    expect_empty(sc, "M1 查询 D12 为空", dev(12), [R(12)])
    sc.done()

    sc = Sc("IQA-012", assumptions=BASE_ASSUME)
    for lab, x in (("不带令牌", query(None, dev(1))), ("无效令牌 X", query("X", dev(1)))):
        sc.cp(lab + " 查询被拒绝为未识别身份(401)", x.status == 401, brief(x))
        sc.cp(lab + " 响应不含 D1 记录内容", R(1) not in (x.body or "") and S1 not in (x.body or ""), brief(x))
        FAIL_TOKEN_CHECKS.append(("IQA-012", lab, tokens_in(x.text_all(), ["X", "I1", "I2", "M1"])))
    sc.done()

    sc = Sc("IQA-013", assumptions=BASE_ASSUME)
    for who in ("I1", "I2"):
        x = query(who, dev(1))
        sc.cp(who + " 查询被拒绝为无权执行该操作(403)", x.status == 403, brief(x))
        sc.cp(who + " 响应不含 D1 记录内容", R(1) not in (x.body or "") and S1 not in (x.body or ""), brief(x))
    sc.done()

    sc = Sc("IQA-014", assumptions=BASE_ASSUME + ([] if HOLDER["I1"] else ["A-10"]))
    r = submit("I1", dev(13), S1, "正常", R(13))
    sc.cp("I1 提交 D13 被接受", r.ok, brief(r))
    q, recs = q_records(dev(13))
    if recs and len(recs) == 1:
        ok, obs = inspector_ok("I1", rget(recs[0], "inspector"))
        sc.cp("巡检员为 I1 的持有人标识", ok, obs)
    else:
        sc.cp("M1 查询 D13 恰好 1 条", False, brief(q))
    leak = tokens_in(r.text_all(), ["I1", "M1"]) + tokens_in(q.text_all(), ["I1", "M1"])
    sc.cp("提交与查询响应（头与正文）不含令牌 I1、M1", not leak, "命中令牌代号: %s" % leak)
    sc.done()

    sc = Sc("IQA-015", assumptions=BASE_ASSUME)
    r = submit("M1", dev(14), S1, "正常", R(14))
    sc.cp("M1 提交被拒绝为无权执行该操作(403)", r.status == 403, brief(r))
    expect_empty(sc, "M1 查询 D14 为空", dev(14), [R(14)])
    sc.done()

    sc = Sc("IQA-016", assumptions=BASE_ASSUME)
    r = submit("I1", dev(15), S2, "正常", R(15))
    sc.cp("前置：I1 提交 D15（门店 S2）被接受", r.ok, brief(r))
    qa_, a = q_records(dev(1))
    qb_, b = q_records(dev(15))
    sc.cp("查询门店 S1 的 D1 成功并返回其记录", bool(a) and all(sval(rget(x, "store")) == S1 for x in a) and R(1) in (qa_.body or ""), brief(qa_))
    sc.cp("查询门店 S2 的 D15 成功且恰好 1 条门店为 S2", b is not None and len(b) == 1 and sval(rget(b[0], "store")) == S2, brief(qb_))
    sc.done()

    sc = Sc("IQA-017", assumptions=BASE_ASSUME + ["A-9"])
    if "?" in API["query"]:
        base_q = API["query"].split("?")[0]
        rs = [http("GET", base_q, who="M1"), query("M1", ""), query("M1", " ")]
    else:
        rs = [http("GET", API["query"].replace("{d}", "%20"), who="M1"),
              http("GET", API["query"].replace("/{d}", ""), who="M1")]
    sc.cp("至少一种不指定设备的查询被拒绝为输入不符合要求并指明设备标识",
          any(is_input(x) and mentions(x, "device") for x in rs), " | ".join(brief(x) for x in rs))
    sc.cp("这些查询都不返回巡检记录", all(not (x.ok and records_of(x)) and RUN not in (x.body or "") for x in rs),
          " | ".join("HTTP %s" % x.status for x in rs))
    sc.done()
    for x in rs:
        if RUN + "-R8" in (x.body or ""):
            LATE_CHECKS.append(("IQA-008-leak", "x"))

    sc = Sc("IQA-021", tag="-phase1", assumptions=BASE_ASSUME + ["A-12"])
    r = submit("I2", dev(16), S1, "异常", R(16))
    sc.cp("删除前：I2 提交 D16 被接受", r.ok, brief(r))
    if r.status == 401:
        ENV_NOTES.append("阶段 1 中 I2 已被拒绝(401)：I2 在测试开始前已从机密配置删除（A-12，环境问题）")
    q, recs = q_records(dev(16))
    sc.cp("删除前：M1 查询 D16 得到 1 条并保存", recs is not None and len(recs) == 1, brief(q))
    SAVED["D16"] = recs
    sc.done()

    for i in range(1, 6):
        SAVED["D%d" % i] = q_records(dev(i))[1]

    # IQA-008 ③: rejected submission must not appear in any query of this run
    sc = Sc("IQA-008", tag="-late", assumptions=BASE_ASSUME)
    hits = []
    for i in range(1, 17):
        q, _ = q_records(dev(i))
        if RUN + "-R8-" in (q.body or ""):
            hits.append(dev(i))
    sc.cp("阶段 1 结束时 M1 查询 D1～D16 与空设备查询均不出现 R8", not hits and ("IQA-008-leak", "x") not in LATE_CHECKS,
          "出现 R8 的设备: %s" % hits)
    sc.done()

# ---------------- phase 2 (after controlled redeploy) ----------------
def canon(recs):
    return sorted(json.dumps(x, sort_keys=True, ensure_ascii=False) for x in (recs or []))


def iqa018():
    sc = Sc("IQA-018", assumptions=BASE_ASSUME + ["A-11"])
    if not MULTI:
        sc.cp("需要在受控重新部署之后验证", False, "本次未分阶段执行（QA_PHASES<2 或无 QA_STATE_DIR），无法重启服务", kind="gap")
        sc.done()
        return
    redeploy = os.environ.get("QA_REDEPLOY_EVIDENCE", "")
    sc.cp("存在重新部署证据", bool(redeploy.strip()), "QA_REDEPLOY_EVIDENCE=%s" % redact(redeploy[:300]), kind="gap")
    for i in range(1, 6):
        before = SAVED.get("D%d" % i)
        r, after = q_records(dev(i))
        sc.cp("重启后查询 D%d 成功" % i, r.ok and after is not None, brief(r))
        sc.cp("D%d 记录条数、标识与全部字段与重启前一致" % i, before is not None and canon(before) == canon(after),
              "重启前 %s 条，重启后 %s 条" % (None if before is None else len(before), None if after is None else len(after)))
    sc.done()


def iqa021_after():
    R = lambda n: "%s-R%s-备注" % (RUN, n)
    S1 = RUN + "-S1"
    sc = Sc("IQA-021", tag="-phase2", assumptions=BASE_ASSUME + ["A-12"])
    if not MULTI:
        sc.cp("收回 I2 后的行为", False, "本次未分阶段执行，运维无法在执行中途删除 I2（A-12）", kind="gap")
        sc.done()
        return
    a = submit("I2", dev(17), S1, "正常", R("17-i2"))
    b = query("I2", dev(16))
    revoked = a.status == 401 or b.status == 401
    if a.ok or b.status == 403:
        sc.cp("I2 已从机密配置删除（前提）", False,
              "I2 仍被识别（提交 HTTP %s / 查询 HTTP %s）：重新部署前未删除 I2，属环境/平台问题（A-12）" % (a.status, b.status), kind="gap")
        ENV_NOTES.append("IQA-021：重新部署后 I2 仍被识别，无法确认运维已删除 I2（A-12）")
    else:
        sc.cp("I2 提交被拒绝为未识别身份(401)", a.status == 401, brief(a))
        sc.cp("I2 查询被拒绝为未识别身份(401)", b.status == 401, brief(b))
    for lab, x in (("I2 提交", a), ("I2 查询", b)):
        if not x.ok:
            FAIL_TOKEN_CHECKS.append(("IQA-021", lab, tokens_in(x.text_all(), ["I2", "I1", "M1", "X"])))
    c = submit("I1", dev(17), S1, "正常", R("17-i1"))
    sc.cp("I1 提交 D17 被接受（其他令牌不受影响）", c.ok, brief(c))
    q, recs = q_records(dev(16))
    sc.cp("M1 查询 D16 与删除前保存结果完全一致", SAVED.get("D16") is not None and canon(SAVED["D16"]) == canon(recs),
          brief(q))
    q, recs = q_records(dev(17))
    if revoked:
        ok = recs is not None and len(recs) == 1 and sval(rget(recs[0], "remark")) == R("17-i1")
        sc.cp("M1 查询 D17 只有 I1 的 1 条记录", ok, brief(q))
    sc.done()


def iqa019():
    sc = Sc("IQA-019", assumptions=["A-13"])
    if not LOG_URL:
        sc.cp("可读取服务日志", False, "未注入机密 QA_SERVICE_LOG_URL（A-13，环境/平台问题）", kind="gap")
        sc.done()
        return
    r = http("GET", "", url=LOG_URL, raw_auth=("Bearer " + LOG_TOKEN) if LOG_TOKEN else None, log=False)
    text = r.body or ""
    if not sc.cp("日志可读取且非空", r.ok and len(text) > 0, "HTTP %s, %d 字节" % (r.status, len(text)), kind="gap"):
        sc.done()
        return
    terms = [(k, TOK[k]) for k in ("I1", "I2", "M1", "X") if TOK[k]] + [("RUN 标记(设备/门店/备注)", RUN)]
    terms += [("holder-" + k, v) for k, v in HOLDER.items() if v]
    counts = {code: text.count(v) for code, v in terms}
    write_json("IQA-019-log-scan.json", {"source": "secret QA_SERVICE_LOG_URL", "bytes": len(text),
                                         "method": "substring count per term", "hits": counts})
    for code, n in counts.items():
        sc.cp("日志中检索 %s 零命中" % code, n == 0, "命中 %d 次" % n)
    sc.done()
    RESULTS["IQA-019"]["evidence"].append("IQA-019-log-scan.json")


def iqa020():
    sc = Sc("IQA-020", assumptions=BASE_ASSUME)
    applicable = [c for c in FAIL_TOKEN_CHECKS if c[1] not in ("不带令牌", "空 Bearer")]
    sc.cp("存在可检查的失败响应", bool(applicable), "%d 个失败响应" % len(applicable), kind="gap")
    for s, lab, found in applicable:
        sc.cp("%s %s 失败响应不含令牌" % (s, lab), not found, "命中令牌代号: %s" % found)
    sc.done()


# ---------------- state, result ----------------
def state_file():
    return os.path.join(STATE_DIR, "qa-state.json")


def save_state():
    x_generated = not sec("QA_INVALID_TOKEN")
    st = {"RUN": RUN, "API": API, "INSP": INSP, "SAVED": SAVED, "RESULTS": RESULTS, "ENV_NOTES": ENV_NOTES,
          "FAIL_TOKEN_CHECKS": FAIL_TOKEN_CHECKS, "X": TOK["X"] if x_generated else None}
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(state_file(), "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False)


def load_state():
    global RUN
    with open(state_file(), encoding="utf-8") as f:
        st = json.load(f)
    RUN = st["RUN"]
    API.update(st["API"])
    INSP.update(st["INSP"])
    SAVED.update(st["SAVED"])
    RESULTS.update(st["RESULTS"])
    ENV_NOTES.extend(st["ENV_NOTES"])
    FAIL_TOKEN_CHECKS.extend([tuple(x) for x in st["FAIL_TOKEN_CHECKS"]])
    if st.get("X"):
        TOK["X"] = st["X"]


ORDER = ["IQA-%03d" % i for i in range(1, 22)]


def write_result(summary_extra="", env_problem=None, global_gaps=None):
    scenarios, defects, gaps, evidence = [], [], list(global_gaps or []), ["run.json"]
    for sid in ORDER:
        r = RESULTS.get(sid)
        if not r:
            continue
        passed = all(c["passed"] for c in r["checkpoints"]) and bool(r["checkpoints"])
        for c in r["checkpoints"]:
            if not c["passed"]:
                line = "%s：%s —— %s" % (sid, c["step"], c["observation"][:400])
                (defects if c["kind"] == "defect" else gaps).append(line)
        scenarios.append({"id": sid, "passed": passed, "externalServices": [],
                          "checkpoints": [{"step": c["step"], "passed": c["passed"], "observation": c["observation"]}
                                          for c in r["checkpoints"]],
                          "evidence": ", ".join(r["evidence"])})
        evidence += r["evidence"]
    if env_problem:
        write_json("env-diagnostics.json", {"problem": env_problem, "transportErrors": ENV_ERRORS[:50],
                                            "serviceVar": SVC_VAR})
        defects, gaps = [], []
        evidence.append("env-diagnostics.json")
    pending = [s for s in ORDER if s not in RESULTS]
    reason = env_problem or "；".join(global_gaps or []) or "本阶段未执行，等待后续阶段"
    for sid in pending:
        scenarios.append({"id": sid, "passed": False, "externalServices": [],
                          "checkpoints": [{"step": "执行场景", "passed": False, "observation": "未执行：" + reason}],
                          "evidence": "env-diagnostics.json" if env_problem else "run.json"})
    scenarios.sort(key=lambda s: s["id"])
    passed = (not env_problem) and not defects and not gaps and not pending and all(s["passed"] for s in scenarios)
    n_ok = sum(1 for s in scenarios if s["passed"])
    summary = "阶段 %d/%d：%d/%d 个场景通过，产品缺陷 %d 条，测试缺口 %d 条。%s" % (
        PHASE, PHASES, n_ok, len(scenarios), len(defects), len(gaps), summary_extra)
    if env_problem:
        summary = "执行环境问题（不计入产品缺陷）：%s" % env_problem
    if ENV_NOTES:
        summary += " 环境说明：" + "；".join(ENV_NOTES)
    write_json("run.json", {"run": RUN, "phase": PHASE, "phases": PHASES, "candidateSha": SHA, "serviceVar": SVC_VAR,
                            "api": API, "discovery": DISC.get("openapi"), "envNotes": ENV_NOTES,
                            "assumptionsByScenario": {k: v["assumptions"] for k, v in RESULTS.items()},
                            "finishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()})
    res = {"passed": passed, "testedCommitSha": SHA, "summary": redact(summary)[:4000], "defects": defects[:200],
           "testGaps": gaps[:200], "evidence": sorted(set(evidence)), "bugfixResults": [], "scenarios": scenarios}
    raw = json.dumps(res, ensure_ascii=False)
    if tokens_in(raw, ["I1", "I2", "M1"]):
        raw = redact(raw)
    with open(RESULT_PATH, "w", encoding="utf-8") as f:
        f.write(raw)


def main():
    global RUN
    if not BASE:
        write_result(env_problem="未注入 AIDH_SERVICE_*_URL，候选服务地址不可用")
        return
    if MISSING_SECRETS:
        write_result(global_gaps=["缺少测试身份机密：%s（请在项目“依赖与机密”页签提供 test 值）" % "、".join(MISSING_SECRETS)],
                     summary_extra="缺少机密 " + "、".join(MISSING_SECRETS))
        return
    if FIRST:
        RUN = "qa" + "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(8))
        del LOGBOOK[:]
        discover(RUN + "-PROBE", RUN + "-S0")
        write_json("discovery.json", {"api": API, "openapi": DISC["openapi"], "steps": DISC["steps"], "requests": list(LOGBOOK)})
        if ENV_ERRORS:
            write_result(env_problem="候选不可达或传输失败：%s" % ENV_ERRORS[0])
            return
        if not API["query"] or not API["submit"]:
            write_result(global_gaps=["按测试计划 A-1/A-3 未能发现%s入口或字段名（见 discovery.json），全部场景无法执行" %
                                      ("查询" if not API["query"] else "提交")])
            return
        phase1()
        if MULTI:
            save_state()
    else:
        load_state()
    if LAST:
        iqa018()
        iqa021_after()
        iqa019()
        iqa020()
    if ENV_ERRORS:
        write_result(env_problem="执行中出现传输失败：%s" % ENV_ERRORS[0])
        return
    write_result("" if LAST else "等待受控重新部署后的阶段 %d。" % (PHASE + 1))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        tb = redact(traceback.format_exc())
        write_json("script-error.json", {"traceback": tb})
        RESULTS.setdefault("IQA-001", {"id": "IQA-001", "checkpoints": [], "evidence": ["script-error.json"], "assumptions": []})
        write_result(global_gaps=["qa-run.sh 内部错误（见 script-error.json）：%s" % tb.strip().splitlines()[-1]])
PYEOF

python3 ./qa_main.py
rc=$?
if [ ! -s "$QA_RESULT_PATH" ]; then
  # Last-resort result so that the platform always receives a valid envelope.
  python3 - <<'PY2'
import json, os
json.dump({"passed": False, "testedCommitSha": os.environ.get("QA_CANDIDATE_SHA", ""),
           "summary": "QA script crashed before writing a result", "defects": [],
           "testGaps": ["qa-run.sh internal error; see stderr of qa-run task"], "evidence": [],
           "bugfixResults": [], "scenarios": []},
          open(os.environ["QA_RESULT_PATH"], "w", encoding="utf-8"), ensure_ascii=False)
PY2
fi
echo "qa-run finished (python exit $rc)" >&2
exit 0
