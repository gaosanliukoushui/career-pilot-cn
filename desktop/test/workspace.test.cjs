const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  isCareerPilotRoot,
  readSavedRoot,
  resolveProjectRoot,
  saveRoot,
} = require("../lib/workspace.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "careerpilot-desktop-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "careerpilot.mjs"), "");
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "config", "cn-campus.defaults.yml"), "market: cn\n");
  return root;
}

test("validates a CareerPilot CN project root", () => {
  const root = fixture();
  assert.equal(isCareerPilotRoot(root), true);
  fs.rmSync(path.join(root, "careerpilot.mjs"));
  assert.equal(isCareerPilotRoot(root), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("saved workspace wins over packaged default and is persisted atomically", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "careerpilot-settings-"));
  const saved = fixture();
  const fallback = fixture();
  const configFile = path.join(userDataDir, "build-config.json");
  fs.writeFileSync(configFile, JSON.stringify({ defaultProjectRoot: fallback }));
  saveRoot(userDataDir, saved);
  assert.equal(readSavedRoot(userDataDir), path.resolve(saved));
  assert.equal(resolveProjectRoot({ userDataDir, packagedConfigFile: configFile, environment: {} }), saved);
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(saved, { recursive: true, force: true });
  fs.rmSync(fallback, { recursive: true, force: true });
});

test("environment override has highest priority when valid", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "careerpilot-env-"));
  const overridden = fixture();
  const saved = fixture();
  saveRoot(userDataDir, saved);
  const configFile = path.join(userDataDir, "missing-config.json");
  assert.equal(
    resolveProjectRoot({
      userDataDir,
      packagedConfigFile: configFile,
      environment: { CAREER_OPS_ROOT: overridden },
    }),
    overridden,
  );
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(overridden, { recursive: true, force: true });
  fs.rmSync(saved, { recursive: true, force: true });
});
