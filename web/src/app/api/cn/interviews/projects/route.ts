import { runCareerPilot } from "@/lib/careerpilot";
import { projectInterviewCoreStatus } from "@/lib/project-interview-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await runCareerPilot(["interview-projects"]);
  if (!result.ok) {
    return Response.json(
      { error: result.error || "无法读取项目面试简历目录", code: result.code },
      { status: projectInterviewCoreStatus(result.code) },
    );
  }
  return Response.json(result.data);
}
