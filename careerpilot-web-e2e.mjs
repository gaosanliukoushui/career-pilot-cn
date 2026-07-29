#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = import.meta.dirname;
const webRoot = join(repoRoot, 'web');
const dataRoot = mkdtempSync(join(tmpdir(), 'careerpilot-web-e2e-'));
mkdirSync(join(dataRoot, 'profile'), { recursive: true });
writeFileSync(join(dataRoot, 'careerpilot.mjs'), `import ${JSON.stringify(pathToFileURL(join(repoRoot, 'careerpilot.mjs')).href)};\n`, 'utf8');
writeFileSync(join(dataRoot, 'profile', 'candidate.yml'), `schema_version: 2
candidate:
  display_name: 匿名候选人
structured:
  education: {}
  language_certificates: []
  credentials: []
  preferences: {}
facts: []
evidence: []
`, 'utf8');

const port = 20_500 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${port}`;
let output = '';
const server = spawn(process.execPath, [join(webRoot, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-H', '127.0.0.1', '-p', String(port)], {
  cwd: webRoot,
  env: { ...process.env, CAREER_OPS_ROOT: dataRoot, NEXT_TELEMETRY_DISABLED: '1', BUILD_DIST: `.next-e2e-${port}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => (output += chunk.toString()));
server.stderr.on('data', (chunk) => (output += chunk.toString()));

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/profile`);
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

  // 1. 匿名建档：导入事实、补证、逐条确认、结构化学历。
  await page.goto(`${baseUrl}/profile`, { waitUntil: 'networkidle' });
  const projectStatements = [
    '完成匿名校园项目；整理交付材料',
    '完成匿名接口联调',
    '完成匿名测试记录',
  ];
  await page.getByPlaceholder(/# 教育经历/).fill(`# 匿名候选人\n\n## 教育经历\n- 本科学历\n\n## 项目经历\n${projectStatements.map((statement) => `- ${statement}`).join('\n')}`);
  await page.getByRole('button', { name: '导入为待确认事实' }).click();
  await page.getByText('本科学历', { exact: true }).first().waitFor();

  const educationFact = page.locator('article').filter({ hasText: '本科学历' });
  await educationFact.getByPlaceholder(/https:\/\//).fill('https://example.invalid/anonymous-degree');
  await educationFact.getByRole('button', { name: '关联强证据' }).click();
  await educationFact.getByRole('button', { name: '确认事实' }).click();
  await educationFact.getByText('已确认', { exact: true }).waitFor();
  for (const statement of projectStatements) {
    const projectFact = page.locator('article').filter({ hasText: statement });
    await projectFact.getByRole('button', { name: '添加本人确认证据' }).click();
    await projectFact.getByRole('button', { name: '确认事实' }).click();
    await projectFact.getByText('已确认', { exact: true }).waitFor();
  }

  const degreeCard = page.getByText('学历层次', { exact: true }).locator('..');
  await degreeCard.locator('select').nth(0).selectOption('bachelor');
  const degreeFactValue = await degreeCard.locator('select').nth(1).locator('option').filter({ hasText: '本科学历' }).getAttribute('value');
  assert.ok(degreeFactValue);
  await degreeCard.locator('select').nth(1).selectOption(degreeFactValue);
  assert.equal(await degreeCard.locator('select').nth(0).inputValue(), 'bachelor');
  assert.equal(await degreeCard.locator('select').nth(1).inputValue(), degreeFactValue);
  const structureSaved = page.waitForResponse((response) => response.url().includes('/api/cn/profile/structured') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '保存资格资料' }).click();
  const structureResponse = await structureSaved;
  assert.equal(structureResponse.status(), 200, await structureResponse.text());
  const structureBody = await structureResponse.json();
  assert.equal(structureBody.structured.education.degree?.value, 'bachelor', structureResponse.request().postData() || 'missing request body');
  await page.getByText('结构化资格资料已保存，引用事实已授权用于岗位匹配和网申草稿', { exact: true }).waitFor();

  // 2. 主简历必须在真实预览之后显式确认。
  await page.goto(`${baseUrl}/cv`, { waitUntil: 'networkidle' });
  await page.frameLocator('iframe[title="简历实时预览"]').getByText('完成匿名校园项目；整理交付材料', { exact: true }).waitFor();
  await page.getByRole('button', { name: '确认当前预览为主简历' }).click();
  await page.getByText(/已确认当前预览为 ready 主简历/).waitFor();

  // 3. 导入 JD，逐条确认规则，再确认整份岗位并执行确定性资格评估。
  const jd = [
    '招聘单位：中国示例集团（中央企业）', '岗位名称：信息技术岗', '岗位代码：IT-E2E-01',
    '校园招聘', '学历要求：本科及以上', '岗位职责：整理交付材料', '工作地点：北京', '报名截止：2027年06月30日',
  ].join('\n');
  await page.goto(`${baseUrl}/job-analysis`, { waitUntil: 'networkidle' });
  await page.getByPlaceholder(/粘贴岗位描述/).fill(jd);
  await page.getByRole('button', { name: '提取为待确认岗位' }).click();
  await page.getByText('岗位结构确认', { exact: true }).waitFor();
  const ruleButtons = page.getByRole('button', { name: '确认规则' });
  for (let index = 0; index < await ruleButtons.count(); index += 1) await ruleButtons.nth(index).click();
  await page.getByRole('button', { name: '确认整份岗位' }).click();
  await page.getByText('结构哈希已锁定').waitFor();
  await page.getByRole('button', { name: '执行资格与匹配评估' }).click();
  await page.getByText('资格结论', { exact: true }).waitFor();
  const evaluationText = await page.locator('body').innerText();
  assert.match(evaluationText, /资格结论\s+符合/);

  // 4. 选择已确认基线，保存完整差异，导出岗位简历。
  const baselineSelect = page.locator('select').filter({ has: page.locator('option', { hasText: '选择已确认主简历' }) });
  const baselineValue = await baselineSelect.locator('option').nth(1).getAttribute('value');
  assert.ok(baselineValue);
  await baselineSelect.selectOption(baselineValue);
  const tailoringSection = page.getByRole('heading', { name: '事实级取舍、排序与受控改写' }).locator('xpath=ancestor::section[1]');
  await tailoringSection.getByText('完成匿名校园项目；整理交付材料', { exact: true }).waitFor();
  await page.getByRole('button', { name: '生成证据约束候选改写' }).click();
  await page.getByText(/已生成 1 条仅重排原事实的候选改写/).waitFor();
  const enabledAccept = tailoringSection.locator('button:not([disabled])').filter({ hasText: '接受改写' });
  assert.equal(await enabledAccept.count(), 1, 'exactly one generated rewrite should be ready for review');
  await enabledAccept.click();
  await page.getByRole('button', { name: '保存并生成完整差异预览' }).click();
  await page.getByText(/25%/).waitFor();
  await page.getByText(/已改变 1 条唯一事实/).waitFor();
  await page.getByRole('button', { name: '导出 MD' }).click();
  await page.getByText(/已导出：/).waitFor();

  // 5. 建立网申材料并通过同一事务路径同步中国详细阶段。
  await page.getByText('岗位特有表单字段与材料（可选）', { exact: true }).click();
  await page.getByLabel('表单字段 JSON').fill(JSON.stringify([{
    id: 'motivation.why_company', label: '为什么选择本单位', category: 'motivation', required: true,
    max_length: 200, source_quote: '官网表单：为什么选择本单位',
  }]));
  await page.getByLabel('岗位材料 JSON').fill(JSON.stringify([{
    id: 'recommendation_form', label: '就业推荐表', required: true, source_quote: '公告：请上传就业推荐表',
  }]));
  const applicationPrepared = page.waitForResponse((response) => response.url().includes('/api/cn/applications/prepare') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '建立网申材料与进度' }).click();
  const applicationResponse = await applicationPrepared;
  assert.equal(applicationResponse.status(), 200, await applicationResponse.text());
  const preparedApplication = (await applicationResponse.json()).application;
  assert.ok(preparedApplication.fields.some((item) => item.id === 'motivation.why_company' && item.source_quote === '官网表单：为什么选择本单位'));
  assert.ok(preparedApplication.materials.some((item) => item.id === 'recommendation_form' && item.source_quote === '公告：请上传就业推荐表'));
  await page.getByText(/网申材料 · #/).waitFor();
  await page.locator('label').filter({ hasText: '为什么选择本单位' }).last().waitFor();
  await page.getByText('就业推荐表', { exact: true }).waitFor();
  const stageSection = page.getByRole('button', { name: '同步阶段' }).locator('..');
  await stageSection.locator('select').selectOption('submitted');
  await stageSection.getByPlaceholder(/阶段备注/).fill('匿名浏览器端到端验收');
  await stageSection.getByRole('button', { name: '同步阶段' }).click();
  await page.getByText(/阶段已同步为 Applied/).waitFor();

  const snapshot = await page.locator('body').innerText();
  assert.doesNotMatch(snapshot, /\b\d{17}[\dXx]\b/);
  assert.doesNotMatch(output, /\b\d{17}[\dXx]\b/);
  const screenshotDir = join(repoRoot, 'output', 'careerpilot');
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: join(screenshotDir, 'web-e2e-cn-v2-v3.png'), fullPage: true });
  console.log('PASS Web E2E：匿名建档 → 证据与结构化资料 → 主简历确认 → JD 规则确认 → 资格报告 → 岗位简历确认与导出 → 网申准备 → 阶段同步');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
