import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_FILE_BYTES = 10 * 1024 * 1024;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^campaign\.[a-f0-9]{24}$/.test(id)) return Response.json({ error: "Campaign ID 无效" }, { status: 400 });
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const files = form.getAll("files").filter((item): item is File => item instanceof File);
    if (!files.length || files.length > 30) return Response.json({ error: "请选择 1–30 个 PDF/DOCX 文件" }, { status: 400 });
    const uploadRoot = path.join(careerOpsRoot(), "jds", "imports");
    await fs.mkdir(uploadRoot, { recursive: true });
    const sources: Array<{ kind: "file"; path: string }> = [];
    for (const file of files) {
      const extension = path.extname(file.name).toLowerCase();
      if (![".pdf", ".docx"].includes(extension) || file.size < 1 || file.size > MAX_FILE_BYTES) continue;
      const bytes = Buffer.from(await file.arrayBuffer());
      const valid = extension === ".pdf" ? bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) : bytes.subarray(0, 2).equals(Buffer.from("PK"));
      if (!valid) continue;
      const storedPath = path.join(uploadRoot, `${Date.now()}-${randomUUID()}${extension}`);
      await fs.writeFile(storedPath, bytes, { flag: "wx" });
      sources.push({ kind: "file", path: storedPath });
    }
    if (!sources.length) return Response.json({ error: "没有可读取的 PDF/DOCX 文件" }, { status: 400 });
    const result = await runCareerPilot(["campaign-import", "--campaign", id, "--stdin", "--allowed-root", uploadRoot], JSON.stringify({ sources }));
    return Response.json(result.ok ? result.data : { error: result.error, details: result.details }, { status: result.ok ? 200 : 422 });
  }
  const body = await request.json().catch(() => ({}));
  if (!Array.isArray(body.sources) || !body.sources.length || body.sources.length > 50) return Response.json({ error: "请提供 1–50 个标准化来源" }, { status: 400 });
  const result = await runCareerPilot(["campaign-import", "--campaign", id, "--stdin"], JSON.stringify({ sources: body.sources }));
  return Response.json(result.ok ? result.data : { error: result.error, code: result.code, details: result.details }, { status: result.ok ? 200 : 422 });
}
