import os, sys, json, shutil
repo = sys.argv[1]; out = sys.argv[2]
import tempfile; db = os.path.join(tempfile.mkdtemp(), "work.db")
shutil.copy(os.path.join(repo, "backend/app/climateshield.db"), db)
os.environ["CLIMATESHIELD_DB_PATH"] = db
sys.path.insert(0, os.path.join(repo, "backend"))
from fastapi.testclient import TestClient
from app.main import app
from app.scenarios import DEFAULT_SCENARIOS

GETS = ["health","risk","risk/summary","resources","resources/summary","demand","scenarios",
        "optimizer/latest","plans/latest","plans/history","impact/latest","methodology",
        "weather/live","weather/imd/status","weather/config"]
SIM = {"hazard_severity_multiplier":1.5,"emergency_demand_multiplier":1.5,"budget_limit_inr":5000000,
       "reserve_buffer_pct":0,"max_travel_time_hours":48,"blocked_routes":[]}

def capture(c, extra=None):
    s = {}
    for p in GETS:
        r = c.get("/api/"+p)
        s[p] = {"status": r.status_code, "body": r.json()}
    r = c.get("/api/impact/export/csv")
    s["impact/export/csv"] = {"status": r.status_code, "text": r.text}
    r = c.post("/api/scenarios/simulate", json=SIM)
    s["POST scenarios/simulate"] = {"status": r.status_code, "body": r.json()}
    if extra: s.update(extra)
    return s

states = {}
with TestClient(app) as c:
    c.post("/api/scenarios/reset")
    r = c.post("/api/optimizer/run", json={})
    states["baseline"] = capture(c, {"POST optimizer/run": {"status": r.status_code, "body": r.json()}})
    for sc in DEFAULT_SCENARIOS:
        c.post("/api/scenarios/reset")
        a = c.post(f"/api/scenarios/{sc['id']}/activate")
        snap = capture(c, {"POST activate": {"status": a.status_code, "body": a.json()}})
        r = c.post("/api/optimizer/run", json={"scenario_id": sc["id"]})
        snap["POST optimizer/run"] = {"status": r.status_code, "body": r.json()}
        states[sc["id"]] = snap
    c.post("/api/scenarios/reset")
    sr = c.post("/api/weather/sync-risk", json={"force": False})
    r = c.post("/api/optimizer/run", json={})
    states["live"] = capture(c, {"POST sync-risk": {"status": sr.status_code, "body": sr.json()},
                                 "POST optimizer/run": {"status": r.status_code, "body": r.json()}})
for k, v in states.items():
    print(k, {p: x["status"] for p, x in v.items() if x["status"] != 200})
json.dump(states, open(out, "w"), separators=(",", ":"))
print("size", os.path.getsize(out))
