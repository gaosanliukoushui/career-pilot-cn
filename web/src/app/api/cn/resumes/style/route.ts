import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await runCareerPilot(["resume-style-show"]);
  return Response.json(result.ok ? result.data : { error: result.error }, { status: result.ok ? 200 : 422 });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (!body) return Response.json({ error: "样式配置无效" }, { status: 400 });
  const result = await runCareerPilot(["resume-style-set", "--stdin"], JSON.stringify(body));
  return Response.json(result.ok ? result.data : { error: result.error, code: result.code, details: result.details }, { status: result.ok ? 200 : 422 });
}
