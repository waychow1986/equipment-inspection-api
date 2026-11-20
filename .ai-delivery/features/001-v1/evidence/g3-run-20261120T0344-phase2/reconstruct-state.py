#!/usr/bin/env python3
"""Rebuild runtime/qa-run.sh phase-1 state (qa-state.json) from the phase-1 evidence
of run qa6vbzj2hg, because the platform-restored QA_STATE_DIR was empty in phase 2.

- SAVED D1..D5: last pre-redeploy M1 queries (IQA-008-late.json, end of phase 1).
- SAVED D16: M1 query in IQA-021-phase1.json.
- RESULTS: checkpoints/assumptions/evidence of each phase-1 scenario file.
- FAIL_TOKEN_CHECKS: recomputed from the redacted failure responses of IQA-011/IQA-012.
Holder placeholders (<I1-HOLDER>/<I2-HOLDER>) are substituted from env vars in memory;
the output file is written only to the temp dir given as argv[2] (outside the repo).
Usage: reconstruct-state.py <phase1-evidence-dir> <out-state-dir>
"""
import json, os, sys, glob

src, out = sys.argv[1], sys.argv[2]
holders = {"<I1-HOLDER>": os.environ.get("AIDH_SECRET_QA_INSPECTOR_1_HOLDER", "").strip(),
           "<I2-HOLDER>": os.environ.get("AIDH_SECRET_QA_INSPECTOR_2_HOLDER", "").strip()}


def unredact(s):
    for k, v in holders.items():
        if v:
            s = s.replace(k, v)
    return s


def load(name):
    with open(os.path.join(src, name), encoding="utf-8") as f:
        return json.load(f)


def records(body):
    j = json.loads(unredact(body))
    return j["records"] if isinstance(j, dict) else j


run = load("run.json")
saved = {}
for r in load("IQA-008-late.json")["requests"]:
    dev = r["url"].split("deviceId=")[-1]
    n = dev.rsplit("-D", 1)[-1]
    if n in ("1", "2", "3", "4", "5") and r["status"] == 200:
        saved["D" + n] = records(r["responseBody"])
for r in load("IQA-021-phase1.json")["requests"]:
    if r["caller"] == "M1" and r["method"] == "GET":
        saved["D16"] = records(r["responseBody"])

results = {}
for path in sorted(glob.glob(os.path.join(src, "IQA-*.json"))):
    fname = os.path.basename(path)
    d = load(fname)
    sid = d["scenario"]
    prev = results.get(sid)
    if prev:
        prev["checkpoints"] += d["checkpoints"]
        prev["evidence"].append(fname)
    else:
        results[sid] = {"id": sid, "checkpoints": list(d["checkpoints"]), "evidence": [fname],
                        "assumptions": d["assumptions"]}

ftc = []
labels = {"IQA-011": {None: "不带令牌", "X": "无效令牌 X", "raw-auth": "空 Bearer"},
          "IQA-012": {None: "不带令牌", "X": "无效令牌 X"}}
for sid, lab in labels.items():
    for r in load(sid + ".json")["requests"]:
        if r["caller"] in lab and r["status"] and r["status"] >= 400:
            text = (r["responseBody"] or "") + json.dumps(r["responseHeaders"], ensure_ascii=False)
            ftc.append([sid, lab[r["caller"]], [k for k in ("X", "I1", "I2", "M1") if "<%s>" % k in text]])

state = {"RUN": run["run"], "API": run["api"], "INSP": {"I1": None, "I2": None}, "SAVED": saved,
         "RESULTS": results, "ENV_NOTES": run.get("envNotes") or [], "FAIL_TOKEN_CHECKS": ftc, "X": None,
         "ENV_ERRORS": [], "I2_EARLY": False}
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, "qa-state.json"), "w", encoding="utf-8") as f:
    json.dump(state, f, ensure_ascii=False)
print("run=%s saved=%s results=%d failTokenChecks=%d" % (
    run["run"], {k: len(v) for k, v in saved.items()}, len(results), len(ftc)))
