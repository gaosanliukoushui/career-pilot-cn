import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { id?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 });
  }
  if (!body.id || typeof body.status !== "string" || !body.status) {
    return Response.json({ error: "Fact ID 和有效状态不能为空" }, { status: 400 });
  }
  const result = await runCareerPilot(["set-status", body.id, body.status!]);
  return Response.json(result.ok ? result.data : { error: result.error, details: result.details }, { status: result.ok ? 200 : 400 });
}
