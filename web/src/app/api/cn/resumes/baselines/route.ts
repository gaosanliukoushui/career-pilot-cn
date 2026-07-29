import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await runCareerPilot(["resume-list", "--approved"]);
  return Response.json(result.ok ? result.data : { error: result.error }, { status: result.ok ? 200 : 422 });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (body.confirmed !== true || !body.variant || body.variant.status !== "draft") {
    return Response.json({ error: "必须提交已实际预览的草稿并显式确认" }, { status: 400 });
  }
  const result = await runCareerPilot(["resume-confirm", "--stdin"], JSON.stringify(body.variant));
  return Response.json(result.ok ? result.data : { error: result.error, details: result.details }, { status: result.ok ? 200 : 422 });
}
