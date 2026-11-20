// Serves the ClimateShield AI REST API on Netlify.
//
// The original backend is a Python/FastAPI service, which Netlify cannot run.
// Its responses were captured with `scripts/snapshot_api.py` for each
// demonstration state (baseline, every preset scenario, live-weather sync).
// This function replays those responses and keeps each visitor's session state
// (active scenario, plan approval, resource edits) in cookies.
import snapshot from "./snapshot.json" with { type: "json" };

type Entry = { status: number; body?: any; text?: string };
type State = Record<string, Entry>;
const STATES = snapshot as unknown as Record<string, State>;

type Session = {
  state: string;
  plan?: "Approved" | "Rejected";
  edits: Record<string, { a?: number; r?: number }>;
  history: any[];
};

const COOKIE = "cs_session";

function readSession(req: Request): Session {
  const raw = req.headers.get("cookie") ?? "";
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (m) {
    try {
      const s = JSON.parse(decodeURIComponent(m[1]));
      if (s && STATES[s.state]) return { edits: {}, history: [], ...s };
    } catch {}
  }
  return { state: "baseline", edits: {}, history: [] };
}

function cookieHeader(s: Session) {
  // Keep only the newest history entries so the cookie stays well under 4KB.
  const trimmed = { ...s, history: s.history.slice(0, 5) };
  return `${COOKIE}=${encodeURIComponent(JSON.stringify(trimmed))}; Path=/; SameSite=Lax; Max-Age=604800`;
}

const clone = <T,>(v: T): T => structuredClone(v);

function json(body: unknown, status = 200, session?: Session) {
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
  if (session) headers["set-cookie"] = cookieHeader(session);
  return new Response(JSON.stringify(body), { status, headers });
}

function entry(s: Session, key: string): Entry {
  return STATES[s.state][key] ?? STATES.baseline[key];
}

function applyResourceEdits(list: any[], s: Session) {
  return list.map((r) => {
    const e = s.edits[r.id];
    if (!e) return r;
    const available = e.a ?? r.available_quantity;
    return {
      ...r,
      available_quantity: available,
      minimum_reserve: e.r ?? r.minimum_reserve,
      total_quantity: available + r.deployed_quantity,
    };
  });
}

function latestPlan(s: Session) {
  const plan = clone(entry(s, "plans/latest").body);
  if (plan && s.plan) {
    plan.plan_status = s.plan;
    plan.is_approved = s.plan === "Approved";
  }
  return plan;
}

async function body(req: Request) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");
  const method = req.method.toUpperCase();
  const s = readSession(req);

  if (method === "GET") {
    switch (path) {
      case "resources":
        return json(applyResourceEdits(entry(s, "resources").body, s));
      case "plans/latest":
        return json(latestPlan(s));
      case "plans/history":
        return json([...s.history, ...entry(s, "plans/history").body]);
      case "impact/export/csv": {
        const e = entry(s, path);
        return new Response(e.text ?? "", {
          status: e.status,
          headers: {
            "content-type": "text/csv",
            "content-disposition": 'attachment; filename="climateshield_impact_report.csv"',
          },
        });
      }
      case "health": {
        const h = clone(entry(s, path).body);
        h.timestamp = new Date().toISOString();
        return json(h);
      }
    }
    if (path.startsWith("weather/live")) return json(entry(s, "weather/live").body);
    const e = STATES.baseline[path] ? entry(s, path) : undefined;
    if (e) return json(e.body, e.status);
    return json({ detail: "Not Found" }, 404);
  }

  if (method === "POST") {
    const activate = path.match(/^scenarios\/([^/]+)\/activate$/);
    if (activate) {
      const id = activate[1];
      if (!STATES[id] || !STATES[id]["POST activate"]) {
        return json({ detail: `Scenario '${id}' not found.` }, 404);
      }
      const next: Session = { state: id, edits: {}, history: s.history };
      return json(STATES[id]["POST activate"].body, 200, next);
    }

    switch (path) {
      case "scenarios/reset":
        return json(
          { status: "success", message: "Database and demonstration scenario successfully reset to baseline state." },
          200,
          { state: "baseline", edits: {}, history: [] },
        );

      case "weather/sync-risk": {
        const next: Session = { state: "live", edits: {}, history: s.history };
        return json(STATES.live["POST sync-risk"].body, 200, next);
      }

      case "weather/refresh":
        return json(entry(s, "weather/live").body);

      case "weather/config": {
        const payload = await body(req);
        return json({ ...entry(s, "weather/config").body, ...payload });
      }

      case "optimizer/run":
        return json(entry(s, "POST optimizer/run").body);

      case "scenarios/simulate": {
        const payload = await body(req);
        const result = clone(entry(s, "POST scenarios/simulate").body);
        result.simulation_parameters = {
          ...result.simulation_parameters,
          ...Object.fromEntries(Object.entries(payload).filter(([k]) => k !== "blocked_routes")),
          blocked_routes_count: Array.isArray(payload.blocked_routes) ? payload.blocked_routes.length : 0,
        };
        return json(result);
      }

      case "resources": {
        const p = await body(req);
        if (!p.region_id || !p.resource_type) {
          return json({ detail: "region_id and resource_type are required." }, 400);
        }
        const id = `${p.region_id}_${String(p.resource_type).replace(/ /g, "_")}`;
        s.edits[id] = {
          ...s.edits[id],
          ...(p.available_quantity != null ? { a: Number(p.available_quantity) } : {}),
          ...(p.minimum_reserve != null ? { r: Number(p.minimum_reserve) } : {}),
        };
        return json({ status: "success", id, message: "Resource inventory successfully updated." }, 200, s);
      }

      case "plans/action": {
        const p = await body(req);
        const plan = latestPlan(s);
        if (!plan || plan.plan_id !== p.plan_id) return json({ detail: `Plan '${p.plan_id}' not found.` }, 404);
        const now = new Date().toISOString();
        if (p.action === "approve") {
          if (plan.is_approved) {
            return json({ detail: "This deployment plan has already been approved and executed." }, 400);
          }
          const transfers: any[] = plan.transfers ?? [];
          s.plan = "Approved";
          s.history = [
            ...transfers.slice(0, 5).map((t) => ({
              id: t.id,
              plan_id: plan.plan_id,
              resource_type: t.resource_type,
              origin_name: t.origin_name ?? t.origin_id,
              destination_name: t.destination_name ?? t.destination_id,
              quantity: t.quantity,
              movement_cost_inr: t.movement_cost_inr,
              executed_at: now,
              executed_by: p.approved_by ?? "Emergency Commander",
            })),
            ...s.history,
          ];
          return json(
            {
              plan_id: plan.plan_id,
              status: "Approved",
              message: `Plan successfully approved! Executed ${transfers.length} physical resource movements and updated inventory.`,
              timestamp: now,
              updated_transfers_count: transfers.length,
            },
            200,
            s,
          );
        }
        if (p.action === "reject") {
          if (plan.is_approved) {
            return json({ detail: "Cannot reject a plan that has already been approved and executed." }, 400);
          }
          s.plan = "Rejected";
          return json(
            {
              plan_id: plan.plan_id,
              status: "Rejected",
              message: "Plan marked as Rejected. Resource inventory and reserves remain unchanged.",
              timestamp: now,
              updated_transfers_count: 0,
            },
            200,
            s,
          );
        }
        return json({ detail: `Invalid action '${p.action}'. Must be 'approve' or 'reject'.` }, 400);
      }
    }
    return json({ detail: "Not Found" }, 404);
  }

  return json({ detail: "Method Not Allowed" }, 405);
};

export const config = { path: "/api/*" };
