import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await runCareerPilot(["audit"]);
  return Response.json(result.data || { error: result.error, details: result.details }, { status: 200 });
}
