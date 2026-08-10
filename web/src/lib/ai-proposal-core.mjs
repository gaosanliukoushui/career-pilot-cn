export class AiProposalError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = "AiProposalError";
    this.code = code;
    this.status = status;
  }
}

export function aiProcessFailureMessage(label) {
  return `${String(label || "AI 结构化建议").slice(0, 80)}失败，请检查 CLI 登录状态或切换模型`;
}

export function proposalTerminationPlan(platform, pid) {
  if (platform !== "win32" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  return { command: "taskkill.exe", args: ["/pid", String(pid), "/t", "/f"] };
}

function assertObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AiProposalError("AI_JSON_OBJECT_REQUIRED", "AI 未返回 JSON 对象");
  }
  return value;
}

function unwrapCliEnvelope(object) {
  if (object.structured_output && typeof object.structured_output === "object" && !Array.isArray(object.structured_output)) {
    return object.structured_output;
  }
  if (typeof object.result === "string") return parseJsonProposalOutput(object.result);
  return object;
}

function balancedJsonObjects(text) {
  const values = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"' && depth > 0) {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try { values.push(assertObject(JSON.parse(text.slice(start, index + 1)))); } catch { /* malformed candidate */ }
        start = -1;
      }
    }
  }
  return values;
}

export function parseJsonProposalOutput(stdout) {
  let candidate = String(stdout || "").trim();
  try {
    return unwrapCliEnvelope(assertObject(JSON.parse(candidate)));
  } catch (error) {
    if (error instanceof AiProposalError) throw error;
    // Some CLIs emit progress JSON before the final result; extract below.
  }
  candidate = candidate.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const objects = balancedJsonObjects(candidate);
  if (!objects.length) {
    if (!candidate.includes("{")) throw new AiProposalError("AI_JSON_OBJECT_REQUIRED", "AI 未返回 JSON 对象");
    throw new AiProposalError("AI_JSON_INVALID", "AI 返回的 JSON 无法解析");
  }
  const envelope = [...objects].reverse().find((object) => object.structured_output || typeof object.result === "string");
  return unwrapCliEnvelope(envelope || objects.at(-1));
}
