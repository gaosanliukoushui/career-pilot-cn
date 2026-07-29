import { spawn } from "node:child_process";
import path from "node:path";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";

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
