import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const UPLOAD_TYPES: Record<string, { kind: "document" | "certificate"; valid: (bytes: Buffer) => boolean }> = {
  ".pdf": { kind: "document", valid: (bytes) => bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) },
  ".docx": {
    kind: "document",
    valid: (bytes) => bytes.length >= 4
      && bytes[0] === 0x50 && bytes[1] === 0x4b
      && bytes.includes(Buffer.from("[Content_Types].xml"))
      && bytes.includes(Buffer.from("word/document.xml")),
  },
  ".png": { kind: "certificate", valid: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  ".jpg": { kind: "certificate", valid: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  ".jpeg": { kind: "certificate", valid: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
};

type EvidenceBody = {
  fact_id?: string;
  id?: string;
  kind?: string;
  ref?: string;
  strength?: "ordinary" | "strong";
  verified_at?: string;
};

export async function POST(req: Request) {
  if ((req.headers.get("content-type") || "").includes("multipart/form-data")) {
    const data = await req.formData();
    const factId = String(data.get("fact_id") || "").trim();
    const file = data.get("file");
    if (!factId || !(file instanceof File)) return Response.json({ error: "请选择事实并上传证据文件" }, { status: 400 });
    if (file.size < 1) return Response.json({ error: "证据文件不能为空" }, { status: 400 });
    if (file.size > MAX_EVIDENCE_BYTES) return Response.json({ error: "证据文件不能超过 10 MB" }, { status: 413 });
    const extension = path.extname(path.basename(file.name)).toLowerCase();
    const uploadType = UPLOAD_TYPES[extension];
    if (!uploadType) return Response.json({ error: "仅支持 PDF、DOCX、PNG 和 JPEG 证据文件" }, { status: 400 });
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!uploadType.valid(bytes)) return Response.json({ error: "文件内容与扩展名不一致或文件结构无效" }, { status: 400 });

    const profileRoot = path.join(careerOpsRoot(), "profile");
    const evidenceRoot = path.join(profileRoot, "evidence");
    const uploadRoot = path.join(evidenceRoot, "imports");
    await fs.mkdir(uploadRoot, { recursive: true });
    for (const directory of [profileRoot, evidenceRoot, uploadRoot]) {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return Response.json({ error: "证据目录安全校验失败" }, { status: 409 });
    }
    const realEvidenceRoot = await fs.realpath(evidenceRoot);
    const realUploadRoot = await fs.realpath(uploadRoot);
    const relativeUpload = path.relative(realEvidenceRoot, realUploadRoot);
    if (relativeUpload.startsWith("..") || path.isAbsolute(relativeUpload)) return Response.json({ error: "证据目录越界" }, { status: 409 });

    const fileId = randomUUID();
    const storedPath = path.join(realUploadRoot, `${fileId}${extension}`);
    await fs.writeFile(storedPath, bytes, { flag: "wx", mode: 0o600 });
    const relativeRef = path.relative(careerOpsRoot(), storedPath).replace(/\\/g, "/");
    const result = await runCareerPilot([
      "attach-evidence", factId,
      "--id", `evidence.upload.${fileId}`,
      "--kind", uploadType.kind,
      "--ref", relativeRef,
      "--strength", "strong",
    ]);
    if (!result.ok) {
      await fs.rm(storedPath, { force: true });
      return Response.json({ error: result.error, details: result.details }, { status: 400 });
    }
    return Response.json(result.data);
  }

  let body: EvidenceBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "请求内容不是有效 JSON" }, { status: 400 });
  }
  if (!body.fact_id || !body.id || !body.kind || !body.ref || !body.strength) {
    return Response.json({ error: "证据字段不完整" }, { status: 400 });
  }
  const args = [
    "attach-evidence", body.fact_id,
    "--id", body.id,
    "--kind", body.kind,
    "--ref", body.ref,
    "--strength", body.strength,
  ];
  if (body.verified_at) args.push("--verified-at", body.verified_at);
  const result = await runCareerPilot(args);
  return Response.json(result.ok ? result.data : { error: result.error, details: result.details }, { status: result.ok ? 200 : 400 });
}
