import { spawn, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const packagedRoot = path.join(desktopRoot, "dist", "win-unpacked");
const executable = path.join(packagedRoot, "CareerPilot CN.exe");
const webRoot = path.join(packagedRoot, "resources", "web");
const entry = path.join(webRoot, "server.js");
const appPathsManifest = path.join(webRoot, ".next", "server", "app-paths-manifest.json");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function fetchWithTimeout(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
}

function forceStopProcessTree(child) {
  if (!child || child.exitCode !== null) return true;
  if (process.platform === "win32" && Number.isSafeInteger(child.pid)) {
    const result = spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 5_000,
    });
    return !result.error && (result.status === 0 || child.exitCode !== null);
  }
  return child.kill("SIGKILL");
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  let closed = false;
  const closePromise = new Promise((resolve) => child.once("close", () => { closed = true; resolve(); }));
  child.kill();
  await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  if (!closed && !forceStopProcessTree(child)) {
    throw new Error("Packaged server process tree could not be terminated.");
  }
  await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (!closed) throw new Error("Packaged server process tree did not close.");
}

function createAnonymousWorkspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), "careerpilot-desktop-smoke-"));
  try {
    mkdirSync(path.join(root, "config"), { recursive: true });
    mkdirSync(path.join(root, "profile"), { recursive: true });
    writeFileSync(path.join(root, "careerpilot.mjs"), [
    "#!/usr/bin/env node",
    "const command = process.argv[2];",
    "if (command === 'interview-projects') {",
    "  process.stdout.write(JSON.stringify({ schema_version: 1, default_source_id: null, sources: [] }) + '\\n');",
    "  process.exit(0);",
    "}",
    "process.stderr.write(JSON.stringify({ error: 'unsupported anonymous smoke command' }) + '\\n');",
    "process.exit(1);",
    "",
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "doctor.mjs"), [
    "#!/usr/bin/env node",
    "process.stdout.write(JSON.stringify({ onboardingNeeded: false, missing: [], warnings: [] }) + '\\n');",
    "",
    ].join("\n"), "utf8");
    writeFileSync(path.join(root, "package.json"), '{"name":"careerpilot-desktop-smoke","private":true}\n', "utf8");
    writeFileSync(path.join(root, "config", "cn-campus.defaults.yml"), "market: cn-campus\n", "utf8");
    writeFileSync(path.join(root, "profile", "candidate.yml"), [
    "schema_version: 2",
    "candidate:",
    "  display_name: 匿名候选人",
    "structured:",
    "  education: {}",
    "  language_certificates: []",
    "  credentials: []",
    "  preferences: {}",
    "facts: []",
    "evidence: []",
    "",
    ].join("\n"), "utf8");
    return root;
  } catch (error) {
    removeAnonymousWorkspace(root);
    throw error;
  }
}

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function removeAnonymousWorkspace(root) {
  if (!root) return;
  let entry;
  try {
    entry = lstatSync(root);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (entry.isSymbolicLink()) throw new Error(`Refusing to remove linked smoke workspace: ${root}`);
  const tempRoot = comparablePath(realpathSync(os.tmpdir()));
  const resolvedParent = comparablePath(realpathSync(path.dirname(root)));
  const resolvedRoot = comparablePath(realpathSync(root));
  if (resolvedParent !== tempRoot || path.dirname(resolvedRoot) !== tempRoot || resolvedRoot !== comparablePath(root)) {
    throw new Error(`Refusing to remove smoke workspace outside the real temp directory: ${root}`);
  }
  rmSync(root, { recursive: true, force: true });
}

const packagedRoutes = JSON.parse(readFileSync(appPathsManifest, "utf8"));
for (const route of [
  "/interview-center/page",
  "/api/cn/interviews/projects/route",
  "/api/cn/interviews/projects/pack/route",
  "/api/cn/interviews/projects/review/route",
]) {
  if (!packagedRoutes[route]) throw new Error(`Packaged route missing: ${route}`);
}

const port = await getFreePort();
const origin = `http://127.0.0.1:${port}`;
const projectRoot = createAnonymousWorkspace();
let child;
let output = "";
let spawnError;
const onSignal = (signal) => {
  const stopped = forceStopProcessTree(child);
  try { removeAnonymousWorkspace(projectRoot); } catch { process.exit(1); }
  process.exit(stopped ? (signal === "SIGINT" ? 130 : 143) : 1);
};

try {
  child = spawn(executable, [entry], {
    cwd: webRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
      CAREER_OPS_ROOT: projectRoot,
      NODE_PATH: path.join(webRoot, "runtime_modules"),
    },
  });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("error", (error) => { spawnError = error; });
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const deadline = Date.now() + 30_000;
  let response;
  let lastBody = "";
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Packaged server exited early.\n${output}`);
    try {
      response = await fetchWithTimeout(`${origin}/api/doctor`);
      if (response.ok) break;
      lastBody = await response.text();
    } catch {
      // Server is still starting or one bounded probe timed out.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!response?.ok) {
    throw new Error(`Packaged server did not become ready (HTTP ${response?.status || "none"}).\n${lastBody}\n${output}`);
  }
  const body = await response.json();
  if (body.available !== true || body.onboardingNeeded !== false) {
    throw new Error(`Packaged server did not open the ready workspace: ${JSON.stringify(body)}`);
  }
  const interviewPage = await fetchWithTimeout(`${origin}/interview-center`);
  const interviewHtml = await interviewPage.text();
  if (!interviewPage.ok || !interviewHtml.includes("项目面试官特训")) {
    throw new Error(`Packaged interview page is unavailable (HTTP ${interviewPage.status}).`);
  }
  const catalogResponse = await fetchWithTimeout(`${origin}/api/cn/interviews/projects`);
  const catalog = await catalogResponse.json();
  if (!catalogResponse.ok || catalog.schema_version !== 1 || !Array.isArray(catalog.sources) || catalog.sources.length !== 0) {
    throw new Error(`Packaged interview catalog is invalid: ${JSON.stringify(catalog)}`);
  }
  for (const action of ["pack", "review"]) {
    const invalid = await fetchWithTimeout(`${origin}/api/cn/interviews/projects/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (invalid.status !== 400) throw new Error(`Packaged ${action} route returned HTTP ${invalid.status}, expected 400.`);
  }
  console.log(JSON.stringify({ ok: true, status: response.status, anonymousWorkspace: true, interview: true, doctor: body }));
} finally {
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  await stopChild(child);
  removeAnonymousWorkspace(projectRoot);
}
