const fs = require("node:fs");
const path = require("node:path");

const SETTINGS_FILE = "settings.json";

function isCareerPilotRoot(candidate) {
  if (!candidate || typeof candidate !== "string") return false;
  const root = path.resolve(candidate);
  return [
    "careerpilot.mjs",
    "package.json",
    path.join("config", "cn-campus.defaults.yml"),
  ].every((entry) => fs.existsSync(path.join(root, entry)));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readSavedRoot(userDataDir) {
  const settings = readJson(path.join(userDataDir, SETTINGS_FILE));
  return typeof settings?.projectRoot === "string" ? settings.projectRoot : "";
}

function saveRoot(userDataDir, projectRoot) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const file = path.join(userDataDir, SETTINGS_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ projectRoot: path.resolve(projectRoot) }, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

function resolveProjectRoot({ userDataDir, packagedConfigFile, environment = process.env }) {
  const config = readJson(packagedConfigFile);
  const candidates = [
    environment.CAREER_OPS_ROOT,
    readSavedRoot(userDataDir),
    config?.defaultProjectRoot,
  ];
  return candidates.find(isCareerPilotRoot) || "";
}

module.exports = {
  SETTINGS_FILE,
  isCareerPilotRoot,
  readSavedRoot,
  resolveProjectRoot,
  saveRoot,
};
