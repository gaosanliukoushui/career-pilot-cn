#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = import.meta.dirname;
const webRoot = join(repoRoot, 'web');
const dataRoot = mkdtempSync(join(tmpdir(), 'careerpilot-web-e2e-'));
mkdirSync(join(dataRoot, 'profile'), { recursive: true });
writeFileSync(join(dataRoot, 'careerpilot.mjs'), `import ${JSON.stringify(pathToFileURL(join(repoRoot, 'careerpilot.mjs')).href)};\n`, 'utf8');
writeFileSync(join(dataRoot, 'profile', 'candidate.yml'), `schema_version: 1
candidate:
  display_name: 匿名候选人
  email: anonymous@example.invalid
  political_status: 共青团员
facts: []
evidence: []
`, 'utf8');

const port = 20_500 + Math.floor(Math.random() * 500);
let output = '';
const server = spawn(process.execPath, [join(webRoot, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-H', '127.0.0.1', '-p', String(port)], {
  cwd: webRoot,
  env: { ...process.env, CAREER_OPS_ROOT: dataRoot, NEXT_TELEMETRY_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => (output += chunk.toString()));
server.stderr.on('data', (chunk) => (output += chunk.toString()));

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/cv`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Web server did not start: ${output.slice(-1000)}`);
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ acceptDownloads: true });
  await page.goto(`http://127.0.0.1:${port}/cv`, { waitUntil: 'networkidle' });
  await page.getByPlaceholder(/# 姓名/).fill('# 匿名候选人\n\n## 项目经历\n- 完成匿名校园项目');
  await page.getByRole('button', { name: '导入为待确认事实' }).click();
  await page.getByText('完成匿名校园项目', { exact: true }).waitFor();
  await page.getByRole('button', { name: '添加用户确认证言' }).click();
  await page.getByText(/ordinary\/user_confirmation/).waitFor();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await page.getByText('可发布').waitFor();
  await page.getByText('技术岗位版', { exact: true }).click();
  await page.getByText('政治面貌').locator('..').getByRole('checkbox').check();
  await page.frameLocator('iframe[title="简历实时预览"]').getByText('完成匿名校园项目', { exact: true }).waitFor();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'MD' }).click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /tech-two-page\.md/);
  const politicalCheckbox = page.getByText('政治面貌').locator('..').getByRole('checkbox');
  await politicalCheckbox.waitFor({ state: 'visible' });
  assert.equal(await politicalCheckbox.isChecked(), false, '导出结束后应清空本次敏感授权');
  await politicalCheckbox.check();
  const refreshedPreview = page.waitForResponse((response) => response.url().includes('/api/resume-variants/preview') && response.request().method() === 'POST');
  await page.getByText('央国企一页版', { exact: true }).click();
  await refreshedPreview;
  assert.equal(await politicalCheckbox.isChecked(), false, '切换 ResumeVariant 模板后应清空敏感授权');
  assert.doesNotMatch(await page.frameLocator('iframe[title="简历实时预览"]').locator('body').textContent(), /政治面貌：共青团员/);
  assert.match(await (await fetch(`http://127.0.0.1:${port}/api/resume-variants/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ template: 'tech-two-page', authorize_political_status: true }),
  })).text(), /政治面貌：共青团员/);
  const screenshotDir = join(repoRoot, 'output', 'careerpilot');
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: join(screenshotDir, 'web-e2e.png'), fullPage: true });
  console.log('PASS Web E2E：导入 → 补证 → 确认 → 模板选择 → 预览 → 敏感授权 → 导出');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
