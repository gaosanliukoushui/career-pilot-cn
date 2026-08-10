import { AiProposalError, runJsonProposal } from "@/lib/ai-proposal";
import { careerOpsRoot } from "@/lib/career-ops";
import { runCareerPilot } from "@/lib/careerpilot";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

type PackBody = {
  source_id?: string;
  project_id?: string;
  target_role?: string;
  cliId?: string;
};

type PromptResult = { prompt?: string };
type ValidationResult = { pack?: unknown };

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as PackBody;
  if (!body.source_id || !body.project_id || !body.cliId) {
    return Response.json({ error: "缺少简历来源、项目或 AI 命令行工具" }, { status: 400 });
  }
  const input = {
    source_id: body.source_id,
    project_id: body.project_id,
    ...(body.target_role?.trim() ? { target_role: body.target_role.trim() } : {}),
  };
  const promptResult = await runCareerPilot<PromptResult>(["interview-pack-prompt", "--stdin"], JSON.stringify(input));
  if (!promptResult.ok || !promptResult.data?.prompt) {
    const status = promptResult.code === "INTERVIEW_RESUME_SOURCE_NOT_FOUND" || promptResult.code === "INTERVIEW_PROJECT_NOT_FOUND" ? 409 : 422;
    return Response.json({ error: promptResult.error || "无法构建项目面试上下文", code: promptResult.code, details: promptResult.details }, { status });
  }
  try {
    const proposal = await runJsonProposal(body.cliId, promptResult.data.prompt, {
      label: "项目面试训练包生成",
      timeoutMs: 150_000,
      maxOutputBytes: 3 * 1024 * 1024,
      schema: JSON.parse(fs.readFileSync(path.join(careerOpsRoot(), "schemas", "cn", "project-interview-pack.schema.json"), "utf8")),
    });
    const validation = await runCareerPilot<ValidationResult>(["interview-pack-validate", "--stdin"], JSON.stringify({ ...input, proposal }));
    if (!validation.ok || !validation.data?.pack) {
      return Response.json({ error: validation.error || "AI 训练包未通过事实与结构校验", code: validation.code, details: validation.details }, { status: 422 });
    }
    return Response.json(validation.data.pack);
  } catch (error) {
    const status = error instanceof AiProposalError ? error.status : 422;
    return Response.json({ error: error instanceof Error ? error.message : "项目面试训练包生成失败" }, { status });
  }
}
