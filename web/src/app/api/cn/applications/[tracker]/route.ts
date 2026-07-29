import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ tracker: string }> }) {
  const { tracker } = await context.params;
  if (!/^\d+$/.test(tracker)) return Response.json({ error: "申请编号无效" }, { status: 400 });
  const result = await runCareerPilot(["application-show", tracker]);
  return Response.json(result.ok ? result.data : { error: result.error }, { status: result.ok ? 200 : 404 });
}

