import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  if (!body.job_id || !body.reason?.trim()) return Response.json({ error: "缺少岗位或排除理由" }, { status: 400 });
  const result = await runCareerPilot(["campaign-exclude", "--campaign", id, "--job", body.job_id, "--stdin"], JSON.stringify({ reason: body.reason }));
  return Response.json(result.ok ? result.data : { error: result.error, code: result.code, details: result.details }, { status: result.ok ? 200 : 422 });
}
