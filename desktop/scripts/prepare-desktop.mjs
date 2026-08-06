import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const projectRoot = path.resolve(desktopRoot, "..");
const buildDir = path.join(desktopRoot, "build");
const sourceIcon = path.join(projectRoot, "web", "src", "app", "icon.svg");
const sourceModules = path.join(projectRoot, "web", ".next", "standalone", "node_modules");
const runtimeModules = path.join(buildDir, "runtime-modules");

fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(
  path.join(desktopRoot, "build-config.json"),
  `${JSON.stringify({ defaultProjectRoot: projectRoot }, null, 2)}\n`,
  "utf8",
);

await sharp(sourceIcon).resize(512, 512).png().toFile(path.join(buildDir, "icon.png"));
if (!fs.existsSync(sourceModules)) {
  throw new Error(`Standalone runtime modules not found: ${sourceModules}`);
}
if (!runtimeModules.startsWith(`${buildDir}${path.sep}`)) {
  throw new Error(`Refusing to replace unsafe runtime path: ${runtimeModules}`);
}
fs.rmSync(runtimeModules, { recursive: true, force: true });
fs.cpSync(sourceModules, runtimeModules, { recursive: true });
console.log(`Desktop build prepared for ${projectRoot}`);
