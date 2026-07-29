import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (typeof body.job_id !== "string" || typeof body.baseline_variant_id !== "string") {
    return Response.json({ error: "缺少岗位 ID 或已确认主简历" }, { status: 400 });
  }
  const { job_id: jobId, baseline_variant_id: baselineId, save, ...options } = body;
  const args = ["resume-tailor-preview", "--job", jobId, "--baseline", baselineId, "--stdin"];
  if (save === true) args.push("--save");
  const result = await runCareerPilot(args, JSON.stringify(options));
  return Response.json(result.ok ? result.data : { error: result.error, details: result.details }, { status: result.ok ? 200 : 422 });
}
