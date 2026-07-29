import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^tailoring\.[a-f0-9]{16,64}$/.test(id)) return Response.json({ error: "岗位简历预览 ID 无效" }, { status: 400 });
  const result = await runCareerPilot(["resume-tailoring-show", id]);
  return Response.json(result.ok ? result.data : { error: result.error, details: result.details }, { status: result.ok ? 200 : 404 });
}
