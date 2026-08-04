import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await runCareerPilot(["campaign-list"]);
  return Response.json(result.ok ? result.data : { error: result.error }, { status: result.ok ? 200 : 500 });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (!body.name?.trim() || !body.employer?.trim()) return Response.json({ error: "请填写 Campaign 名称和招聘企业" }, { status: 400 });
  const result = await runCareerPilot(["campaign-create", "--stdin"], JSON.stringify(body));
  return Response.json(result.ok ? result.data : { error: result.error, code: result.code, details: result.details }, { status: result.ok ? 201 : 422 });
}
