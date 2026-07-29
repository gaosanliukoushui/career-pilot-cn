import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { careerOpsRoot } from "@/lib/career-ops";
import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

export async function POST(req: Request) {
  let body: { format?: string; variant?: { template?: string } };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 });
  }
  if (!body.format || !MIME[body.format]) return Response.json({ error: "仅支持 Markdown、DOCX 和 PDF" }, { status: 400 });
  if (!body.variant?.template || !["ready", "exported"].includes((body.variant as { status?: string }).status || "")) {
    return Response.json({ error: "请先预览并确认主简历，再执行正式导出" }, { status: 409 });
  }
  const file = `${body.variant.template}-${randomUUID()}.${body.format}`;
  const relativeOutput = path.posix.join("output", "careerpilot", file);
  const args = ["resume-export", "--variant-stdin", "--format", body.format, "--output", relativeOutput];
  const result = await runCareerPilot<{ path?: string }>(args, JSON.stringify(body.variant));
  if (!result.ok || !result.data?.path) {
    return Response.json({ error: result.error || "导出失败", details: result.details }, { status: 400 });
  }
  const absolute = path.resolve(result.data.path);
  const allowedRoot = path.resolve(careerOpsRoot(), "output", "careerpilot");
  if (!absolute.startsWith(`${allowedRoot}${path.sep}`) || !fs.existsSync(absolute)) {
    return Response.json({ error: "导出文件路径无效" }, { status: 500 });
  }
  return new Response(fs.readFileSync(absolute), {
    headers: {
      "content-type": MIME[body.format],
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file)}`,
      "x-careerpilot-output": relativeOutput,
    },
  });
}
