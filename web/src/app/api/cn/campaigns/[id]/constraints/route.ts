import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  if (!body) return Response.json({ error: "约束格式无效" }, { status: 400 });
  const result = await runCareerPilot(["campaign-constraints", "--campaign", id, "--stdin"], JSON.stringify(body));
  return Response.json(result.ok ? result.data : { error: result.error, code: result.code, details: result.details }, { status: result.ok ? 200 : 422 });
}
