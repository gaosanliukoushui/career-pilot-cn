import { ApiJsonRequestError, readBoundedJsonObject, readTextField } from "@/lib/api-json";
import { AiProposalError, runJsonProposal } from "@/lib/ai-proposal";
import { runCareerPilot } from "@/lib/careerpilot";
import { buildProjectInterviewRetryPrompt, projectInterviewCoreStatus, shouldRetryProjectInterviewProposal, shouldUseProjectInterviewFallback } from "@/lib/project-interview-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type PromptResult = { prompt?: string; proposal_schema?: Record<string, unknown> };
type ValidationResult = { review?: unknown };
type FallbackResult = { review?: unknown; generation_mode?: string };

export async function POST(request: Request) {
  let sourceId: string;
  let projectId: string;
  let targetRole: string;
  let question: string;
  let answer: string;
  let cliId: string;
  try {
    const body = await readBoundedJsonObject(request);
    sourceId = readTextField(body, "source_id", { required: true, maximum: 160 });
    projectId = readTextField(body, "project_id", { required: true, maximum: 120 });
    targetRole = readTextField(body, "target_role", { maximum: 120 });
    question = readTextField(body, "question", { required: true, maximum: 1200 });
    answer = readTextField(body, "answer", { required: true, maximum: 6000 });
    cliId = readTextField(body, "cliId", { required: true, maximum: 40 });
  } catch (error) {
    const status = error instanceof ApiJsonRequestError ? error.status : 400;
    const message = status === 413 && error instanceof Error ? error.message : "缺少或无效的简历来源、项目、面试问题、候选人回答或 AI 命令行工具";
    return Response.json({ error: message }, { status });
  }
  if (cliId !== "codex") {
    return Response.json({ error: "项目面试仅支持隔离运行的 Codex" }, { status: 400 });
  }
  const input = {
    source_id: sourceId,
    project_id: projectId,
    question,
    answer,
    ...(targetRole ? { target_role: targetRole } : {}),
  };
  const promptResult = await runCareerPilot<PromptResult>(["interview-review-prompt", "--stdin"], JSON.stringify(input));
  if (!promptResult.ok || !promptResult.data?.prompt || !promptResult.data.proposal_schema) {
    return Response.json(
      { error: promptResult.error || "无法构建项目面试反馈上下文", code: promptResult.code, details: promptResult.details },
      { status: projectInterviewCoreStatus(promptResult.code) },
    );
  }
  try {
    let modelPrompt = promptResult.data.prompt;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const proposal = await runJsonProposal(cliId, modelPrompt, {
        label: "项目面试回答点评",
        timeoutMs: 120_000,
        maxOutputBytes: 2 * 1024 * 1024,
        schema: promptResult.data.proposal_schema,
        signal: request.signal,
      });
      const validation = await runCareerPilot<ValidationResult>(["interview-review-validate", "--stdin"], JSON.stringify({ ...input, review: proposal }));
      if (validation.ok && validation.data?.review) return Response.json(validation.data.review);
      if (shouldUseProjectInterviewFallback(validation.code, attempt)) {
        const fallback = await runCareerPilot<FallbackResult>(["interview-review-fallback", "--stdin"], JSON.stringify(input));
        if (fallback.ok && fallback.data?.review) {
          return Response.json(fallback.data.review, { headers: { "X-CareerPilot-Generation-Mode": "deterministic-fallback" } });
        }
        return Response.json(
          { error: fallback.error || "确定性项目面试反馈生成失败", code: fallback.code, details: fallback.details },
          { status: projectInterviewCoreStatus(fallback.code) },
        );
      }
      if (!shouldRetryProjectInterviewProposal(validation.code, attempt)) {
        return Response.json(
          { error: validation.error || "AI 面试反馈未通过事实与结构校验", code: validation.code, details: validation.details },
          { status: projectInterviewCoreStatus(validation.code) },
        );
      }
      modelPrompt = buildProjectInterviewRetryPrompt(promptResult.data.prompt, validation.details);
    }
    return Response.json({ error: "AI 面试反馈未通过事实与结构校验" }, { status: 422 });
  } catch (error) {
    const status = error instanceof AiProposalError ? error.status : 500;
    return Response.json({ error: error instanceof Error ? error.message : "项目面试回答点评失败" }, { status });
  }
}
