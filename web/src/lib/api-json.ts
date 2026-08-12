export class ApiJsonRequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ApiJsonRequestError";
  }
}

export async function readBoundedJsonObject(request: Request, maximumBytes = 64 * 1024) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ApiJsonRequestError("请求体超过安全上限", 413);
  }
  if (!request.body) return {} as Record<string, unknown>;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ApiJsonRequestError("请求体超过安全上限", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ApiJsonRequestError("请求体必须是 JSON 对象");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiJsonRequestError) throw error;
    throw new ApiJsonRequestError("请求体不是有效 JSON");
  }
}

export function readTextField(
  body: Record<string, unknown>,
  field: string,
  options: { required?: boolean; maximum: number },
) {
  const value = body[field];
  if (value === undefined || value === null) {
    if (options.required) throw new ApiJsonRequestError(`缺少字段 ${field}`);
    return "";
  }
  if (typeof value !== "string") throw new ApiJsonRequestError(`字段 ${field} 必须是字符串`);
  const text = value.trim();
  if (options.required && !text) throw new ApiJsonRequestError(`字段 ${field} 不能为空`);
  if (text.length > options.maximum) throw new ApiJsonRequestError(`字段 ${field} 超过 ${options.maximum} 字符`);
  return text;
}
