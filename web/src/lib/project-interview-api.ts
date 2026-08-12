const INPUT_ERRORS = new Set([
  "INTERVIEW_INPUT_INVALID",
  "INTERVIEW_INPUT_TOO_LARGE",
  "INTERVIEW_INPUT_FORBIDDEN",
]);

const SOURCE_ERRORS = new Set([
  "INTERVIEW_RESUME_SOURCE_NOT_FOUND",
  "INTERVIEW_PROJECT_NOT_FOUND",
]);

export function projectInterviewCoreStatus(code?: string) {
  if (!code || code.startsWith("INTERVIEW_SYSTEM_FILE_")) return 500;
  if (INPUT_ERRORS.has(code)) return 400;
  if (SOURCE_ERRORS.has(code)) return 409;
  return 422;
}

const RETRYABLE_PROPOSAL_ERRORS = new Set([
  "INTERVIEW_PACK_INVALID",
  "INTERVIEW_REVIEW_INVALID",
]);

export function shouldRetryProjectInterviewProposal(code: string | undefined, attempt: number) {
  return attempt === 0 && Boolean(code && RETRYABLE_PROPOSAL_ERRORS.has(code));
}

export function shouldUseProjectInterviewFallback(code: string | undefined, attempt: number) {
  return attempt === 1 && Boolean(code && RETRYABLE_PROPOSAL_ERRORS.has(code));
}

type ValidationDetail = { code?: unknown; path?: unknown; fact_id?: unknown };

export function buildProjectInterviewRetryPrompt(prompt: string, details: unknown) {
  const safeDetails = Array.isArray(details)
    ? details.slice(0, 16).map((item) => {
      const detail = item && typeof item === "object" ? item as ValidationDetail : {};
      return {
        code: typeof detail.code === "string" ? detail.code.slice(0, 80) : "validation_error",
        path: typeof detail.path === "string" ? detail.path.slice(0, 160) : "/",
        ...(typeof detail.fact_id === "string" ? { fact_id: detail.fact_id.slice(0, 160) } : {}),
      };
    })
    : [];
  return [
    prompt,
    "上一次输出未通过 CareerPilot 的结构与事实校验。不要解释原因；重新从头返回一个完整 JSON 对象。",
    "只修复下列服务端错误代码、路径和 Fact ID，不复制其他错误字段，也不要改变请求中的固定哈希、枚举、题号或事实边界：",
    JSON.stringify(safeDetails),
  ].join("\n\n");
}
