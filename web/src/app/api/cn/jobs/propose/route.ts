import { AiProposalError, runJsonProposal } from "@/lib/ai-proposal";
import { runCareerPilot } from "@/lib/careerpilot";
import type { JobPosting } from "@/lib/cn-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 150;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { posting?: JobPosting; cliId?: string };
  if (!body.posting || !body.cliId) return Response.json({ error: "缺少岗位结构或 AI 命令行工具" }, { status: 400 });
  if (body.posting.confirmation?.status !== "confirmed") return Response.json({ error: "请先逐条确认岗位结构和资格规则" }, { status: 409 });
  const contextResult = await runCareerPilot<{ facts?: Array<{ id: string; type: string; statement: string }>; structured?: unknown }>(["job-context"]);
  if (!contextResult.ok || !contextResult.data) return Response.json({ error: contextResult.error || "无法读取脱敏事实上下文" }, { status: 422 });
  const context = contextResult.data;
  const prompt = [
    "你是 CareerPilot CN 的只读匹配建议器。不得使用工具、不得写文件、不得补造候选人事实。",
    "资格硬筛由确定性核心负责；你只评估六个软匹配维度。每个判断必须引用给定 fact id，没有证据就降低分数并说明待补。",
    "只输出一个 JSON 对象，不要 Markdown。格式：",
    '{"dimensions":[{"id":"role_major|evidence|career_direction|mobility|development|source_reliability","score":0,"candidate_fact_ids":[],"rationale":""}],"strengths":[],"gaps":[]}',
    `岗位：${JSON.stringify(body.posting)}`,
    `已脱敏且允许用于匹配的候选人事实：${JSON.stringify(context)}`,
  ].join("\n\n");
  try {
    const proposal = await runJsonProposal(body.cliId, prompt, { label: "AI 匹配建议" });
    const validation = await runCareerPilot(["job-proposal-validate", "--stdin"], JSON.stringify(proposal));
    if (!validation.ok) throw new Error(validation.error || "AI 建议未通过结构化校验");
    return Response.json(validation.data);
  } catch (error) {
    const status = error instanceof AiProposalError ? error.status : 422;
    return Response.json({ error: error instanceof Error ? error.message : "AI 匹配建议失败" }, { status });
  }
}
