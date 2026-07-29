import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[a-z0-9][a-z0-9._-]+$/.test(id)) return Response.json({ error: "主简历 ID 无效" }, { status: 400 });
  const result = await runCareerPilot(["resume-variant-show", id]);
  return Response.json(result.ok ? result.data : { error: result.error }, { status: result.ok ? 200 : 404 });
}

