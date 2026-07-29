import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await runCareerPilot(["show"]);
  return Response.json(result.ok ? result.data : { error: result.error }, { status: result.ok ? 200 : 422 });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (body.action === "migrate") {
    const result = await runCareerPilot(["migrate-profile"]);
    return Response.json(result.ok ? result.data : { error: result.error, details: result.details }, { status: result.ok ? 200 : 422 });
  }
  if (!body.structured || typeof body.structured !== "object") return Response.json({ error: "缺少结构化资料" }, { status: 400 });
  const result = await runCareerPilot(["profile-structure", "--stdin"], JSON.stringify({ structured: body.structured, authorize_uses: true }));
  return Response.json(result.ok ? result.data : { error: result.error, code: result.code, details: result.details }, { status: result.ok ? 200 : 422 });
}

