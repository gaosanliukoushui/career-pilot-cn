import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";

export async function POST() {
  const result = await runCareerPilot(["project-cv"]);
  return Response.json(result.ok ? result.data : { error: result.error, details: result.details }, { status: result.ok ? 200 : 409 });
}
