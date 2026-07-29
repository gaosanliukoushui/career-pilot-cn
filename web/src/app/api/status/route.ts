import { spawn } from "node:child_process";
import path from "node:path";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Web is a thin caller of set-status.mjs. State validation, row resolution,
// locking, atomic replacement and note idempotency all remain in the canonical
// tracker writer instead of being reimplemented in a route.
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { n?: string; status?: string; note?: string };
  if (!body.n || typeof body.status !== "string" || !body.status.trim()) {
    return Response.json({ error: "n and status required" }, { status: 400 });
  }
  const sidecars = await runCareerPilot<{ applications?: Array<{ tracker_num: number; current_stage: string; canonical_status: string }> }>(["application-list"]);
  if (sidecars.ok && sidecars.data?.applications?.length) {
    const numeric = /^\d+$/.test(String(body.n)) ? Number(body.n) : null;
    const linked = numeric == null ? null : sidecars.data.applications.find((item) => item.tracker_num === numeric);
    if (linked || numeric == null) {
      return Response.json({
        error: linked
          ? "该记录已有中国申请侧车，请在详细阶段页更新，不能从旧状态接口覆盖"
          : "存在中国申请侧车时，旧状态接口不能用公司名安全定位；请在详细阶段页更新",
        code: "CN_APPLICATION_REQUIRES_STAGE_UPDATE",
        details: linked ? {
          tracker_status_requested: body.status.trim(),
          sidecar_status: linked.canonical_status,
          stage: linked.current_stage,
        } : { sidecar_tracker_nums: sidecars.data.applications.map((item) => item.tracker_num) },
      }, { status: 409 });
    }
  }
  const args = [rootScript("set-status"), String(body.n), body.status.trim(), "--json"];
  if (typeof body.note === "string" && body.note.trim()) args.push("--note", body.note.trim());
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: careerOpsRoot(),
      env: { ...process.env, CAREER_OPS_TRACKER: path.join(careerOpsRoot(), "data", "applications.md") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ code: 1, stdout: "", stderr: error.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(result.stdout.trim() || "{}"); } catch { payload = { error: result.stderr.trim() || "status update failed" }; }
  if (result.code === 0) return Response.json({ ok: true, ...payload });
  const status = result.code === 2 ? 404 : result.code === 3 ? 409 : result.code === 4 ? 423 : 400;
  return Response.json({ error: payload.error || result.stderr.trim() || "status update failed", ...payload }, { status });
}
