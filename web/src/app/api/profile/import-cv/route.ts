import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { content?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 });
  }
  if (typeof body.content !== "string" || !body.content.trim()) {
    return Response.json({ error: "请提供需要导入的简历内容" }, { status: 400 });
  }
  const result = await runCareerPilot(["import-cv", "--stdin"], body.content);
  return Response.json(result.ok ? result.data : { error: result.error, details: result.details }, { status: result.ok ? 200 : 400 });
}
