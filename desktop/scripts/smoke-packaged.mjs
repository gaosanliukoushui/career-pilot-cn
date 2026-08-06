import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const projectRoot = path.resolve(desktopRoot, "..");
const packagedRoot = path.join(desktopRoot, "dist", "win-unpacked");
const executable = path.join(packagedRoot, "CareerPilot CN.exe");
const webRoot = path.join(packagedRoot, "resources", "web");
const entry = path.join(webRoot, "server.js");
const port = 31418;
const child = spawn(executable, [entry], {
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

let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });

try {
  const deadline = Date.now() + 30_000;
  let response;
  let lastBody = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged server exited early.\n${output}`);
    try {
      response = await fetch(`http://127.0.0.1:${port}/api/doctor`);
      if (response.ok) break;
      lastBody = await response.text();
    } catch {
      // Server is still starting.
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
  console.log(JSON.stringify({ ok: true, status: response.status, projectRoot, doctor: body }));
} finally {
  if (child.exitCode === null) child.kill();
}
