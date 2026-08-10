import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await runCareerPilot(["interview-projects"]);
  if (!result.ok) {
    return Response.json({ error: result.error || "无法读取项目面试简历目录", code: result.code }, { status: 422 });
  }
  return Response.json(result.data);
}

