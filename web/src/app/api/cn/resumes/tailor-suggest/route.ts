import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (typeof body.job_id !== "string" || typeof body.baseline_variant_id !== "string") {
    return Response.json({ error: "缺少岗位 ID 或已确认主简历" }, { status: 400 });
  }
  const result = await runCareerPilot([
    "resume-tailor-suggest", "--job", body.job_id, "--baseline", body.baseline_variant_id,
  ]);
  return Response.json(result.ok ? result.data : { error: result.error, details: result.details }, { status: result.ok ? 200 : 422 });
}
