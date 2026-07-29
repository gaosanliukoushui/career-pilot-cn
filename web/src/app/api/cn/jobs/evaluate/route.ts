import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: "请求格式无效" }, { status: 400 }); }
  if (!body.posting || typeof body.posting !== "object") return Response.json({ error: "缺少已确认的岗位结构" }, { status: 400 });
  const result = await runCareerPilot(["job-evaluate", "--stdin"], JSON.stringify(body));
  return Response.json(result.ok ? result.data : { error: result.error, code: result.code, details: result.details }, { status: result.ok ? 200 : 422 });
}

