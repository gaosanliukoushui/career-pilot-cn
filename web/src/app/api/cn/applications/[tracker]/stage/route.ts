import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ tracker: string }> }) {
  const { tracker } = await context.params;
  const body = await request.json().catch(() => ({}));
  if (!/^\d+$/.test(tracker) || typeof body.stage !== "string") return Response.json({ error: "申请编号或阶段无效" }, { status: 400 });
  const args = ["application-stage", tracker, body.stage];
  if (typeof body.note === "string" && body.note.trim()) args.push("--note", body.note.trim());
  const result = await runCareerPilot(args);
  const status = result.ok ? 200 : result.code === "APPLICATION_STATUS_CONFLICT" ? 409
    : result.code === "LOCK_TIMEOUT" ? 423 : 422;
  return Response.json(result.ok ? result.data : { error: result.error, code: result.code, details: result.details }, { status });
}
