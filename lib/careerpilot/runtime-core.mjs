import Ajv2020 from 'ajv/dist/2020.js';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'cn', 'runtime-capability-report.schema.json'), 'utf8'));
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

function external(value) {
  return { ...(value && typeof value === 'object' ? value : {}), declared: value?.declared === true };
}

export function inspectProjectBrowserMcpConfig(root) {
  const candidates = ['.mcp.json', '.claude/settings.json', '.claude/settings.local.json'];
  const files = [];
  for (const relativePath of candidates) {
    const path = join(root, ...relativePath.split('/'));
    if (!existsSync(path)) continue;
    try {
      const servers = JSON.parse(readFileSync(path, 'utf8'))?.mcpServers;
      if (servers && Object.values(servers).some((server) => JSON.stringify(server).toLowerCase().includes('playwright'))) files.push(relativePath);
    } catch { /* malformed project config is reported as not configured */ }
  }
  return { configured: files.length > 0, files };
}

async function probePlaywright() {
  let chromium;
  try { ({ chromium } = await import('playwright')); } catch (error) {
    return { available: false, launchable: false, error: error.message };
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    return { available: true, launchable: true, error: null };
  } catch (error) {
    return { available: true, launchable: false, error: error.message };
  } finally {
    try { await browser?.close(); } catch { /* best-effort probe cleanup */ }
  }
}

export async function inspectRuntimeCapabilities(root, declarations = {}, hooks = {}) {
  const playwright = await (hooks.probePlaywright || probePlaywright)();
  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    playwright_cli: { available: Boolean(playwright.available), launchable: Boolean(playwright.launchable), error: playwright.error || null },
    project_browser_mcp_config: inspectProjectBrowserMcpConfig(root),
    external_runtimes: {
      codex_browser: external(declarations.codex_browser),
      chrome: external(declarations.chrome),
      edge: external(declarations.edge),
    },
    active_import_mode: declarations.current_import_mode === 'codex_browser_capture'
      && (declarations.codex_browser?.declared || declarations.chrome?.declared || declarations.edge?.declared)
      ? 'codex_browser_capture'
      : declarations.current_import_mode === 'text_or_file' ? 'text_or_file' : 'batch_url',
    fallback_order: ['codex_browser_capture', 'batch_url', 'text_or_file'],
  };
  if (!validate(report)) {
    const error = new Error('Runtime capability report validation failed');
    error.code = 'RUNTIME_CAPABILITY_INVALID';
    error.details = validate.errors;
    throw error;
  }
  return report;
}
