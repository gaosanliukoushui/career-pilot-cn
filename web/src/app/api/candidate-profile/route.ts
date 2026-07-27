import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await runCareerPilot(["show"]);
  return Response.json(result.ok ? result.data : { error: result.error }, { status: result.ok ? 200 : 500 });
}
