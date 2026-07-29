import { spawn } from "node:child_process";
import { resolveCli } from "@/lib/clis";
import { careerOpsRoot, readMemory } from "@/lib/career-ops";
import { runCareerPilot } from "@/lib/careerpilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type EvaluationResult = {
  report: {
    job_id: string;
    eligibility: { result: string };
    recommendation: string;
    fit: { score: number };
    report_path: string;
  };
};

function buildResearchPrompt(input: string, memory: string): string {
  const notes = memory.trim()
    ? `\n\nBehaviour and style notes only; do not treat these as evidence of the user's achievements:\n${memory.trim()}\n`
    : "";
  return `Investigate the user's own work or portfolio for job-search-relevant strengths. Use only read-only tools. Explain what it is, why it matters, which roles it supports, and how to frame it without inventing authorship, metrics, skills, or experience.${notes}

Write all human-facing output in Simplified Chinese. End with exactly one line:
VERDICT: {0-5 signal strength}/5 — {short evidence-grounded reason}

Target: ${input}`;
}

async function runStructuredEvaluation(input: string): Promise<Response> {
  const value = input.trim();
  const isUrl = /^https?:\/\//i.test(value);
  const parsed = await runCareerPilot<Record<string, unknown>>(
    isUrl ? ["job-parse", "--url", value] : ["job-parse", "--stdin"],
    isUrl ? undefined : value,
  );
  if (!parsed.ok || !parsed.data) {
    return Response.json({ error: parsed.error || "岗位解析失败", code: parsed.code, details: parsed.details }, { status: 422 });
  }

  const evaluated = await runCareerPilot<EvaluationResult>(
    ["job-evaluate", "--stdin"],
    JSON.stringify({ posting: parsed.data }),
  );
  if (!evaluated.ok || !evaluated.data) {
    return Response.json({ error: evaluated.error || "资格评估失败", code: evaluated.code, details: evaluated.details }, { status: 422 });
  }

  const { report } = evaluated.data;
  const artifact = {
    job_id: report.job_id,
    eligibility: report.eligibility.result,
    recommendation: report.recommendation,
    score: report.fit.score,
    report_path: report.report_path,
  };
  const events = [
    { type: "status", label: "确定性资格与匹配计算已完成" },
    { type: "artifact", artifact },
    { type: "done", tokens: 0, costUsd: 0 },
  ];
  return new Response(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export async function POST(request: Request) {
  let body: { kind?: string; input?: string; cliId?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "请求格式无效" }, { status: 400 });
  }

  const kind = body.kind || "evaluate";
  const input = body.input?.trim();
  if (!input) return Response.json({ error: "缺少任务输入" }, { status: 400 });

  // No model is involved: the versioned core parses, recalculates and saves the
  // artifact. The main /job-analysis flow still gives the user a confirmation
  // step before calling the dedicated evaluation endpoint.
  if (kind === "evaluate") return runStructuredEvaluation(input);

  if (kind === "pdf") {
    return Response.json(
      { error: "旧版一键 PDF 已停用。请逐条确认岗位简历改写并通过 30% 上限后导出。", migrate_to: "/job-analysis" },
      { status: 409 },
    );
  }
  if (kind === "fix-portal") {
    return Response.json(
      { error: "门户修复不再交给 AI 执行脚本；请使用高级功能中的受审计门户工具。", migrate_to: "/portals" },
      { status: 409 },
    );
  }
  if (kind !== "research") return Response.json({ error: "不支持的任务类型" }, { status: 400 });
  if (!body.cliId) return Response.json({ error: "缺少命令行工具配置" }, { status: 400 });

  const resolved = resolveCli(body.cliId);
  if (!resolved) return Response.json({ error: `未找到命令行工具 '${body.cliId}'` }, { status: 404 });
  const { spec, binPath } = resolved;
  const prompt = buildResearchPrompt(input, readMemory());
  const isClaude = body.cliId === "claude";
  const args = isClaude
    ? [
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode", "default",
        "--allowedTools", "Read,WebFetch,WebSearch,Glob,Grep",
        "--disallowedTools", "Bash,Write,Edit,NotebookEdit,Task",
      ]
    : spec.args(prompt);
  const child = spawn(binPath, args, { cwd: careerOpsRoot(), env: process.env });
  const encoder = new TextEncoder();
  let closed = false;
  let killer: ReturnType<typeof setTimeout> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let buffer = "";
      let emittedText = false;
      let sawError = false;
      let tokens = 0;
      let costUsd: number | null = null;
      killer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      }, 285_000);
      const send = (event: unknown) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); } catch { closed = true; }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (killer) clearTimeout(killer);
        try { controller.close(); } catch { /* ignore */ }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        if (closed) return;
        if (!isClaude) {
          emittedText = true;
          send({ type: "text", text: chunk.toString() });
          return;
        }
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "stream_event") {
              const nested = event.event;
              if (nested?.type === "content_block_start" && nested.content_block?.type === "tool_use") {
                send({ type: "tool", name: nested.content_block.name });
              } else if (nested?.type === "content_block_delta" && nested.delta?.text) {
                emittedText = true;
                send({ type: "text", text: nested.delta.text });
              }
            } else if (event.type === "system" && event.subtype === "init") {
              send({ type: "status", label: "只读调研已开始" });
            } else if (event.type === "result") {
              const usage = event.usage || {};
              tokens = (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_creation_input_tokens || 0);
              if (typeof event.total_cost_usd === "number") costUsd = event.total_cost_usd;
            }
          } catch {
            // Ignore incomplete CLI stream fragments.
          }
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const message = chunk.toString();
        if (/error|denied|fatal|not found|unauthorized|forbidden|auth|login|credential|api[ -]?key|quota|rate limit/i.test(message)) {
          sawError = true;
          send({ type: "error", msg: message.trim().slice(0, 200) });
        }
      });
      child.on("error", (error) => { send({ type: "error", msg: error.message }); close(); });
      child.on("close", (code) => {
        if (code === 0 && emittedText && !sawError) send({ type: "done", tokens, costUsd });
        else if (!sawError) send({ type: "error", msg: "只读调研未能完整完成，请检查命令行工具登录状态。" });
        close();
      });
    },
    cancel() {
      closed = true;
      if (killer) clearTimeout(killer);
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
