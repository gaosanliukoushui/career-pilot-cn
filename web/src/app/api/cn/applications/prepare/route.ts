import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (typeof body.job_id !== "string") return Response.json({ error: "缺少岗位 ID" }, { status: 400 });
  const result = await runCareerPilot(["application-prepare", "--job", body.job_id]);
  return Response.json(result.ok ? result.data : { error: result.error, details: result.details }, { status: result.ok ? 200 : 422 });
}

