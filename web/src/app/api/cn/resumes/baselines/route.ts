import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await runCareerPilot(["resume-list", "--approved"]);
  return Response.json(result.ok ? result.data : { error: result.error }, { status: result.ok ? 200 : 422 });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const template = typeof body.template === "string" ? body.template : "soe-one-page";
  if (!["soe-one-page", "tech-two-page", "application-detail"].includes(template)) {
    return Response.json({ error: "主简历模板无效" }, { status: 400 });
  }
  const result = await runCareerPilot(["resume-save", "--template", template, "--ready"]);
  return Response.json(result.ok ? result.data : { error: result.error, details: result.details }, { status: result.ok ? 200 : 422 });
}
