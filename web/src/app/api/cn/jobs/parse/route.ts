import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_FILE_BYTES = 10 * 1024 * 1024;

function error(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const data = await request.formData();
    const file = data.get("file");
    if (!(file instanceof File)) return error("请选择 PDF 或 DOCX 招聘文件");
    if (file.size < 1 || file.size > MAX_FILE_BYTES) return error("招聘文件必须小于 10 MB");
    const extension = path.extname(file.name).toLowerCase();
    if (![".pdf", ".docx"].includes(extension)) return error("首版仅支持 PDF 和 DOCX，不支持图片 OCR");
    const bytes = Buffer.from(await file.arrayBuffer());
    const signatureOk = extension === ".pdf"
      ? bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))
      : bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
    if (!signatureOk) return error("文件内容与扩展名不一致");
    const uploadRoot = path.join(careerOpsRoot(), "jds", "imports");
    await fs.mkdir(uploadRoot, { recursive: true });
    const storedPath = path.join(uploadRoot, `${Date.now()}-${randomUUID()}${extension}`);
    await fs.writeFile(storedPath, bytes, { flag: "wx" });
    const result = await runCareerPilot(["job-parse", "--file", storedPath]);
    if (!result.ok) {
      await fs.rm(storedPath, { force: true });
      return error(result.error || "招聘文件解析失败", 422);
    }
    return Response.json(result.data);
  }

  let body: { kind?: "text" | "url"; text?: string; url?: string };
  try { body = await request.json(); } catch { return error("请求格式无效"); }
  if (body.kind === "url") {
    if (!body.url?.trim()) return error("请输入官网招聘链接");
    const result = await runCareerPilot(["job-parse", "--url", body.url.trim()]);
    return Response.json(result.ok ? result.data : { error: result.error }, { status: result.ok ? 200 : 422 });
  }
  if (!body.text?.trim()) return error("请粘贴岗位描述或招聘公告");
  if (body.text.length > 2_000_000) return error("岗位文本过长");
  const result = await runCareerPilot(["job-parse", "--stdin"], body.text);
  return Response.json(result.ok ? result.data : { error: result.error }, { status: result.ok ? 200 : 422 });
}

