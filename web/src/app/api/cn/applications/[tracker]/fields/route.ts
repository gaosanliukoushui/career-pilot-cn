import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ tracker: string }> }) {
  const { tracker } = await context.params;
  if (!/^\d+$/.test(tracker)) return Response.json({ error: "申请编号无效" }, { status: 400 });
  const updates = await request.json().catch(() => null);
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) return Response.json({ error: "字段更新格式无效" }, { status: 400 });
  const result = await runCareerPilot(["application-fields", tracker, "--stdin"], JSON.stringify(updates));
  return Response.json(result.ok ? result.data : { error: result.error, code: result.code, details: result.details }, { status: result.ok ? 200 : 422 });
}
