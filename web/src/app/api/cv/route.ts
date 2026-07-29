import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { runCareerPilot } from "@/lib/careerpilot";

function cvPath() {
  return path.join(careerOpsRoot(), "cv.md");
}

const MAX_CV_BYTES = 200_000;

export async function GET() {
  const hasCandidateProfile = fs.existsSync(path.join(careerOpsRoot(), "profile", "candidate.yml"));
  if (hasCandidateProfile) {
    const projected = await runCareerPilot<{ markdown?: string }>(["preview-cv"]);
    if (projected.ok && projected.data?.markdown) {
      return NextResponse.json({ content: projected.data.markdown, exists: true, generated: true });
    }
  }
  try {
    return NextResponse.json({ content: fs.readFileSync(cvPath(), "utf8"), exists: true, generated: false });
  } catch {
    return NextResponse.json({ content: "", exists: false });
  }
}

export async function POST(req: Request) {
  let body: { content?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求内容不是有效 JSON" }, { status: 400 });
  }
  if (typeof body.content !== "string") {
    return NextResponse.json({ error: "缺少简历内容" }, { status: 400 });
  }
  if (Buffer.byteLength(body.content, "utf8") > MAX_CV_BYTES) {
    return NextResponse.json({ error: "简历文件过大（超过 200KB）" }, { status: 413 });
  }
  return NextResponse.json(
    {
      error: "cv.md 现在是事实库生成的只读视图，请导入旧简历或编辑事实。",
      code: "CV_READ_ONLY",
      next: "/api/candidate-profile/import-cv",
    },
    { status: 409 },
  );
}
