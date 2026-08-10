import { AiProposalError, runJsonProposal } from "@/lib/ai-proposal";
import { careerOpsRoot } from "@/lib/career-ops";
import { runCareerPilot } from "@/lib/careerpilot";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

type ReviewBody = {
  source_id?: string;
  project_id?: string;
  target_role?: string;
  question?: string;
  answer?: string;
  cliId?: string;
};

type PromptResult = { prompt?: string };
type ValidationResult = { review?: unknown };

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as ReviewBody;
  if (!body.source_id || !body.project_id || !body.question?.trim() || !body.answer?.trim() || !body.cliId) {
    return Response.json({ error: "缺少简历来源、项目、面试问题、候选人回答或 AI 命令行工具" }, { status: 400 });
  }
  const input = {
    source_id: body.source_id,
    project_id: body.project_id,
    question: body.question.trim(),
    answer: body.answer.trim(),
    ...(body.target_role?.trim() ? { target_role: body.target_role.trim() } : {}),
  };
  const promptResult = await runCareerPilot<PromptResult>(["interview-review-prompt", "--stdin"], JSON.stringify(input));
  if (!promptResult.ok || !promptResult.data?.prompt) {
    const status = promptResult.code === "INTERVIEW_INPUT_INVALID" || promptResult.code === "INTERVIEW_INPUT_TOO_LARGE" ? 400
      : promptResult.code === "INTERVIEW_RESUME_SOURCE_NOT_FOUND" || promptResult.code === "INTERVIEW_PROJECT_NOT_FOUND" ? 409 : 422;
    return Response.json({ error: promptResult.error || "无法构建项目面试反馈上下文", code: promptResult.code, details: promptResult.details }, { status });
  }
  try {
    const proposal = await runJsonProposal(body.cliId, promptResult.data.prompt, {
      label: "项目面试回答点评",
      timeoutMs: 150_000,
      maxOutputBytes: 2 * 1024 * 1024,
      schema: JSON.parse(fs.readFileSync(path.join(careerOpsRoot(), "schemas", "cn", "project-interview-review.schema.json"), "utf8")),
    });
    const validation = await runCareerPilot<ValidationResult>(["interview-review-validate", "--stdin"], JSON.stringify({ ...input, review: proposal }));
    if (!validation.ok || !validation.data?.review) {
      return Response.json({ error: validation.error || "AI 面试反馈未通过事实与结构校验", code: validation.code, details: validation.details }, { status: 422 });
    }
    return Response.json(validation.data.review);
  } catch (error) {
    const status = error instanceof AiProposalError ? error.status : 422;
    return Response.json({ error: error instanceof Error ? error.message : "项目面试回答点评失败" }, { status });
  }
}
