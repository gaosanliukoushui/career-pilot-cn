import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (!body.preview || !["md", "html", "docx", "pdf"].includes(body.format)) {
    return Response.json({ error: "缺少定制预览或导出格式无效" }, { status: 400 });
  }
  const args = ["resume-tailor-export", "--stdin", "--format", body.format];
  if (typeof body.campaign_id === "string") args.push("--campaign", body.campaign_id);
  const result = await runCareerPilot(args, JSON.stringify(body.preview));
  return Response.json(result.ok ? result.data : { error: result.error, details: result.details }, { status: result.ok ? 200 : 422 });
}
