import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^job\.[a-f0-9]{16,64}$/.test(id)) return Response.json({ error: "岗位 ID 无效" }, { status: 400 });
  const result = await runCareerPilot(["job-show", id]);
  return Response.json(result.ok ? result.data : { error: result.error }, { status: result.ok ? 200 : 404 });
}

