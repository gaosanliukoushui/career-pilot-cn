import { spawn } from "node:child_process";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";

export type CareerPilotResult<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
  details?: unknown;
};

/**
 * Execute the canonical CareerPilot CN domain CLI. Web routes intentionally do
 * not implement profile validation or publication policy themselves.
 */
export function runCareerPilot<T = unknown>(args: string[], stdin?: string): Promise<CareerPilotResult<T>> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [rootScript("careerpilot"), ...args, "--root", careerOpsRoot()], {
      cwd: careerOpsRoot(),
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => resolve({ ok: false, error: error.message }));
    child.on("close", (code) => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse((stdout.trim() || stderr.trim()) || "{}");
      } catch {
        resolve({ ok: false, error: (stderr || stdout).trim().slice(0, 500) || "CareerPilot core returned no result" });
        return;
      }
      if (code === 0) resolve({ ok: true, data: parsed as T });
      else resolve({
        ok: false,
        data: parsed as T,
        error: String(parsed.error || "CareerPilot audit found blocking issues"),
        code: parsed.code as string | undefined,
        details: parsed.details,
      });
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
