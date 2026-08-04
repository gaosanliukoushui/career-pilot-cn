import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const jobIds = Array.isArray(body.job_ids) ? body.job_ids : body.job_id ? [body.job_id] : [];
  if (!jobIds.length || !body.reason?.trim()) return Response.json({ error: "请选择岗位并填写选择理由" }, { status: 400 });
  const result = await runCareerPilot(["campaign-select", "--campaign", id, "--job", jobIds.join(","), "--stdin"], JSON.stringify({ reason: body.reason }));
  return Response.json(result.ok ? result.data : { error: result.error, code: result.code, details: result.details }, { status: result.ok ? 200 : 422 });
}
