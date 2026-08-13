import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Server-only (node imports). The agnostic runtimes career-ops can delegate to
// in headless mode (AGENTS.md). Install URLs from career-ops-docs.
export type CliSpec = {
  id: string;
  name: string;
  bin: string;
  run: string;
  url: string;
  /** headless invocation args for a single prompt */
  args: (prompt: string) => string[];
  /** Enforceable policy used by the Web proposal runner. */
  proposalPolicy: "no-tools" | "isolated-no-tools" | "unsupported";
};

export const KNOWN: CliSpec[] = [
  { id: "claude", name: "Claude Code", bin: "claude", run: "claude -p", url: "https://claude.ai/code", args: (p) => ["-p", p], proposalPolicy: "no-tools" },
  { id: "codex", name: "Codex", bin: "codex", run: "codex exec", url: "https://developers.openai.com/codex/cli", args: (p) => ["exec", p], proposalPolicy: "isolated-no-tools" },
  { id: "gemini", name: "Gemini CLI", bin: "gemini", run: "gemini -p", url: "https://github.com/google-gemini/gemini-cli", args: (p) => ["-p", p], proposalPolicy: "unsupported" },
  { id: "opencode", name: "OpenCode", bin: "opencode", run: "opencode run", url: "https://opencode.ai", args: (p) => ["run", p], proposalPolicy: "unsupported" },
  { id: "copilot", name: "GitHub Copilot CLI", bin: "copilot", run: "copilot -p", url: "https://docs.github.com/en/copilot/github-copilot-in-the-cli", args: (p) => ["-p", p], proposalPolicy: "unsupported" },
  { id: "qwen", name: "Qwen CLI", bin: "qwen", run: "qwen -p", url: "https://qwen.ai/qwencode", args: (p) => ["-p", p], proposalPolicy: "unsupported" },
  { id: "antigravity", name: "Antigravity CLI", bin: "agy", run: "agy -p", url: "https://antigravity.google", args: (p) => ["-p", p], proposalPolicy: "unsupported" },
];

export function proposalCapable(id: string): boolean {
  return KNOWN.some((item) => item.id === id && item.proposalPolicy !== "unsupported");
}

type ProposalOutputOptions = {
  schemaJson?: string;
  schemaPath?: string;
  mcpConfigPath?: string;
};

const CLAUDE_PROPOSAL_SYSTEM_PROMPT = [
  "You are a JSON transformation worker.",
  "Follow the complete task and trusted data supplied on stdin.",
  "Do not inspect the repository, read files, call tools, propose implementation work, or ask questions.",
  "Return only the JSON object requested by the stdin task.",
].join(" ");

export function proposalArgs(id: string, output: ProposalOutputOptions = {}): string[] {
  if (id === "claude") {
    if (!output.mcpConfigPath) {
      throw new Error("Claude proposal execution requires an isolated MCP config file");
    }
    return [
      "-p", "--output-format", "json", "--permission-mode", "dontAsk",
      "--tools", "",
      "--disallowedTools", "Bash,Write,Edit,Read,WebFetch,WebSearch,Glob,Grep,Task,NotebookEdit",
      "--disable-slash-commands", "--no-chrome",
      // Claude 2.1.x treats an empty value as missing and consumes the next
      // option as the setting source. The proposal runner uses a fresh cwd, so
      // `local` loads no user/project rules while keeping normal OAuth auth.
      "--setting-sources", "local",
      "--mcp-config", output.mcpConfigPath, "--strict-mcp-config",
      "--system-prompt", CLAUDE_PROPOSAL_SYSTEM_PROMPT,
      // The task is bounded JSON planning over a handful of verified Facts.
      // Pin the fast alias so a user-level long-context default cannot turn a
      // single interview turn into a multi-minute request.
      "--model", "haiku",
      "--effort", "low",
      "--no-session-persistence",
      ...(output.schemaJson ? ["--json-schema", output.schemaJson] : []),
    ];
  }
  if (id === "codex") {
    return [
      "exec", "-", "--ephemeral", "--ignore-user-config",
      "--ignore-rules", "--skip-git-repo-check", "--strict-config", "--color", "never",
      "-c", "approval_policy='never'",
      "-c", "web_search='disabled'",
      "-c", "project_doc_max_bytes=0",
      "-c", "developer_instructions='You are a JSON transformation worker. Do not use tools or external context. Follow the complete task supplied on stdin and return only the requested JSON object.'",
      "-c", "apps._default.enabled=false",
      "-c", "tools.web_search=false",
      "-c", "default_permissions='careerpilot-proposal'",
      "-c", "permissions.careerpilot-proposal={description='CareerPilot proposal isolation',filesystem={':root'='deny',':minimal'='read',':workspace_roots'={'.'='read'},':tmpdir'='deny',':slash_tmp'='deny'},network={enabled=false}}",
      ...[
        "shell_tool", "unified_exec", "code_mode", "code_mode_host", "code_mode_only",
        "apps", "enable_mcp_apps", "plugins", "hooks", "browser_use",
        "browser_use_external", "browser_use_full_cdp_access", "computer_use", "multi_agent",
        "image_generation", "tool_suggest", "workspace_dependencies", "skill_mcp_dependency_install",
        "request_permissions_tool", "in_app_browser", "plugin_sharing", "remote_plugin", "memories",
      ].flatMap((feature) => ["--disable", feature]),
      ...(output.schemaPath ? ["--output-schema", output.schemaPath] : []),
    ];
  }
  throw new Error(`CLI ${id} does not expose an enforceable Web proposal policy`);
}

export function minimalCliEnv(id: string, source: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
  const common = [
    "PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "HOME",
    "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL", "TERM", "COLORTERM",
  ];
  const credentials = id === "claude"
    ? ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"]
    : id === "codex" ? ["OPENAI_API_KEY", "CODEX_HOME"] : [];
  return {
    NODE_ENV: process.env.NODE_ENV || "production",
    ...Object.fromEntries([...common, ...credentials]
      .filter((key) => typeof source[key] === "string")
      .map((key) => [key, source[key] as string])),
  } as NodeJS.ProcessEnv;
}

const CLAUDE_SETTING_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
]);

export function proposalCliEnv(
  id: string,
  source: Record<string, string | undefined> = process.env,
  claudeSettingsPath = path.join(os.homedir(), ".claude", "settings.json"),
): NodeJS.ProcessEnv {
  const env = minimalCliEnv(id, source);
  if (id !== "claude") return env;
  try {
    const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, "utf8")) as { env?: Record<string, unknown> };
    for (const [key, value] of Object.entries(settings.env || {})) {
      if (CLAUDE_SETTING_ENV_KEYS.has(key) && typeof value === "string" && value) env[key] = value;
    }
  } catch {
    // OAuth/keychain or explicit process environment may already be sufficient.
  }
  return env;
}

function searchDirs(): string[] {
  const home = os.homedir();
  const extra = [
    path.join(home, ".local/bin"),
    path.join(home, ".npm-global/bin"),
    path.join(home, ".bun/bin"),
    path.join(home, ".deno/bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  if (process.platform === "win32") {
    // Windows CLIs frequently install under per-user AppData roots and don't
    // reliably add themselves to PATH (e.g. Antigravity → %LOCALAPPDATA%\agy\bin).
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    extra.push(
      path.join(localAppData, "agy", "bin"), // Antigravity CLI
      path.join(localAppData, "Microsoft", "WindowsApps"), // winget/Store shims
      path.join(appData, "npm"), // npm global prefix on Windows
    );
  }
  const fromPath = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return [...new Set([...fromPath, ...extra])];
}

// On Windows, extensionless npm shims are POSIX shell scripts and cannot be
// launched by child_process.spawn. Only return PATHEXT entries that we know how
// to execute; POSIX keeps the bare executable name.
function binCandidates(bin: string): string[] {
  if (process.platform !== "win32") return [bin];
  const pathext = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  const exts = pathext
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean)
    // Only include extensions that `child_process.spawn()` can execute directly.
    .filter((e) => [".com", ".exe", ".bat", ".cmd"].includes(e.toLowerCase()));

  return exts.map((ext) => bin + ext);
}

export function findBin(bin: string, dirs = searchDirs()): string | null {
  for (const dir of dirs) {
    for (const candidate of binCandidates(bin)) {
      const p = path.join(dir, candidate);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

export function cliCapabilityFlags(
  cli: Pick<CliSpec, "id" | "proposalPolicy">,
  installed: boolean,
) {
  return {
    proposalAvailable: installed && cli.id === "claude" && cli.proposalPolicy !== "unsupported",
    projectInterviewAvailable: installed && cli.id === "codex" && cli.proposalPolicy === "isolated-no-tools",
  };
}

export function detectClis() {
  const dirs = searchDirs();
  return KNOWN.map((c) => {
    const found = findBin(c.bin, dirs);
    const capabilities = cliCapabilityFlags(c, Boolean(found));
    return {
      id: c.id, name: c.name, run: c.run, url: c.url, installed: !!found, path: found,
      proposalPolicy: c.proposalPolicy,
      ...capabilities,
    };
  });
}

export function resolveCli(id: string): { spec: CliSpec; binPath: string } | null {
  const spec = KNOWN.find((c) => c.id === id);
  if (!spec) return null;
  const binPath = findBin(spec.bin);
  if (!binPath) return null;
  return { spec, binPath };
}

export function resolveProposalCli(id: string): { spec: CliSpec; binPath: string } | null {
  if (!proposalCapable(id)) return null;
  return resolveCli(id);
}
