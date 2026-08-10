import { spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { minimalCliEnv, proposalArgs, resolveProposalCli } from "./clis";
import { AiProposalError, aiProcessFailureMessage, parseJsonProposalOutput, proposalTerminationPlan } from "./ai-proposal-core.mjs";

export { AiProposalError, aiProcessFailureMessage, parseJsonProposalOutput } from "./ai-proposal-core.mjs";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

type RunJsonProposalOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
  label?: string;
  schema?: Record<string, unknown>;
};

function nativeExecutableFromNpmShim(binPath: string) {
  if (process.platform !== "win32" || !/\.cmd$/i.test(binPath)) return null;
  try {
    const source = readFileSync(binPath, "utf8");
    const match = source.match(/"%dp0%\\([^"\r\n]+\.exe)"\s+%\*/iu);
    if (!match) return null;
    const candidate = path.resolve(path.dirname(binPath), match[1].replaceAll("\\", path.sep));
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function commandForSpawn(binPath: string, args: string[]) {
  const nativeExecutable = nativeExecutableFromNpmShim(binPath);
  if (nativeExecutable) return { command: nativeExecutable, args, shell: false };
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(binPath)) {
    return { command: binPath, args, shell: false };
  }
  const tokens = [binPath, ...args];
  if (tokens.some((value) => /[\r\n"&|<>^%!]/u.test(value))) {
    throw new AiProposalError("AI_CLI_UNAVAILABLE", "AI 命令行工具路径或固定参数不符合 Windows 安全策略", 500);
  }
  // npm installs CLI tools as .cmd shims. The prompt is deliberately excluded
  // from this fixed shell command and sent only over stdin below.
  return { command: tokens.map((value) => `"${value}"`).join(" "), args: [], shell: true };
}

function terminateProposalProcess(child: ChildProcessWithoutNullStreams) {
  const plan = proposalTerminationPlan(process.platform, child.pid);
  if (plan) {
    const result = spawnSync(plan.command, plan.args, {
      windowsHide: true,
      stdio: "ignore",
      timeout: 5_000,
    });
    if (!result.error) return;
  }
  child.kill("SIGTERM");
}

export async function runJsonProposal(cliId: string, prompt: string, options: RunJsonProposalOptions = {}) {
  const resolved = resolveProposalCli(cliId);
  if (!resolved) {
    throw new AiProposalError("AI_CLI_UNAVAILABLE", "所选 AI 命令行工具未安装，或无法强制只读/无工具策略", 404);
  }
  const timeoutMs = Math.min(Math.max(options.timeoutMs || DEFAULT_TIMEOUT_MS, 10_000), 180_000);
  const maxOutputBytes = Math.min(Math.max(options.maxOutputBytes || DEFAULT_MAX_OUTPUT_BYTES, 64 * 1024), 4 * 1024 * 1024);
  const label = options.label || "AI 结构化建议";
  const { spec, binPath } = resolved;
  const isolatedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "careerpilot-cn-proposal-"));
  try {
    let schemaPath: string | undefined;
    let schemaJson: string | undefined;
    if (options.schema) {
      schemaJson = JSON.stringify(options.schema);
      schemaPath = path.join(isolatedCwd, "output.schema.json");
      await fs.writeFile(schemaPath, schemaJson, "utf8");
    }
    const invocation = commandForSpawn(binPath, proposalArgs(spec.id, { schemaJson, schemaPath }));
    const output = await new Promise<string>((resolveOutput, reject) => {
      const spawnOptions: SpawnOptionsWithoutStdio = {
        cwd: isolatedCwd,
        env: minimalCliEnv(spec.id),
        stdio: "pipe",
      };
      const child: ChildProcessWithoutNullStreams = invocation.shell
        ? spawn(invocation.command, { ...spawnOptions, shell: process.env.ComSpec || process.env.COMSPEC || true })
        : spawn(invocation.command, invocation.args, spawnOptions);
      let stdout = "";
      let outputBytes = 0;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const timer = setTimeout(() => {
        terminateProposalProcess(child);
        fail(new AiProposalError("AI_TIMEOUT", `${label}超时`));
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > maxOutputBytes) {
          terminateProposalProcess(child);
          fail(new AiProposalError("AI_OUTPUT_TOO_LARGE", `${label}输出超过安全上限`));
          return;
        }
        stdout += chunk.toString();
      });
      // Some CLIs echo the full prompt to stderr. Drain it, but never retain or
      // return it to the browser because the prompt contains resume facts.
      child.stderr.on("data", () => {});
      child.stdin.on("error", () => { /* process may reject before consuming stdin */ });
      child.on("error", (error) => fail(error));
      child.on("close", (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code === 0 && stdout.trim()) resolveOutput(stdout);
        else reject(new AiProposalError("AI_PROCESS_FAILED", aiProcessFailureMessage(label)));
      });
      child.stdin.end(prompt);
    });
    return parseJsonProposalOutput(output) as Record<string, unknown>;
  } finally {
    // Windows antivirus/indexers can hold a just-closed CLI working directory
    // for a few milliseconds. Cleanup is best-effort because this directory
    // contains at most the public JSON schema (the resume prompt stays on
    // stdin), and a transient cleanup failure must never replace the model
    // result or the original validation error.
    try {
      await fs.rm(isolatedCwd, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 125,
      });
    } catch {
      // A later OS temp cleanup can remove the empty/schema-only directory.
    }
  }
}
