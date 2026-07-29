import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { minimalCliEnv, proposalArgs, resolveProposalCli } from "@/lib/clis";
import { runCareerPilot } from "@/lib/careerpilot";
import type { JobPosting } from "@/lib/cn-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 150;

function parseJsonOutput(stdout: string): unknown {
  let candidate = stdout.trim();
  try {
    const outer = JSON.parse(candidate);
    if (typeof outer?.result === "string") candidate = outer.result;
    else return outer;
  } catch { /* parse the assistant text below */ }
  candidate = candidate.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI 未返回 JSON 对象");
  return JSON.parse(candidate.slice(start, end + 1));
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { posting?: JobPosting; cliId?: string };
  if (!body.posting || !body.cliId) return Response.json({ error: "缺少岗位结构或 AI 命令行工具" }, { status: 400 });
  if (body.posting.confirmation?.status !== "confirmed") return Response.json({ error: "请先逐条确认岗位结构和资格规则" }, { status: 409 });
  const resolved = resolveProposalCli(body.cliId);
  if (!resolved) return Response.json({ error: "所选 AI 命令行工具未安装，或无法强制只读/无工具策略" }, { status: 404 });
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
  const { spec, binPath } = resolved;
  const args = proposalArgs(spec.id, prompt);
  const isolatedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "careerpilot-cn-proposal-"));
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(binPath, args, { cwd: isolatedCwd, env: minimalCliEnv(spec.id), stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("AI 匹配建议超时")); }, 120_000);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && stdout.trim()) resolve(stdout);
        else reject(new Error(stderr.trim().slice(0, 500) || "AI 匹配建议失败"));
      });
    });
    const proposal = parseJsonOutput(output);
    const validation = await runCareerPilot(["job-proposal-validate", "--stdin"], JSON.stringify(proposal));
    if (!validation.ok) throw new Error(validation.error || "AI 建议未通过结构化校验");
    return Response.json(validation.data);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "AI 匹配建议失败" }, { status: 422 });
  } finally {
    await fs.rm(isolatedCwd, { recursive: true, force: true });
  }
}
