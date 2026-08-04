#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectRuntimeCapabilities } from './lib/careerpilot/runtime-core.mjs';
import { cleanupCareerPilotRuns } from './lib/careerpilot/cleanup-core.mjs';
import { DEFAULT_RESUME_STYLE, loadResumeStyle, saveResumeStyle } from './lib/careerpilot/resume-style-core.mjs';

test('能力报告区分 Playwright CLI、项目 MCP 和调用方声明的浏览器标签页', async () => {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-runtime-'));
  const report = await inspectRuntimeCapabilities(root, {
    codex_browser: { declared: true, provider: 'codex', current_tabs: 3 },
    current_import_mode: 'codex_browser_capture',
  }, { probePlaywright: async () => ({ available: true, launchable: true }) });
  assert.equal(report.schema_version, 1);
  assert.equal(report.playwright_cli.launchable, true);
  assert.equal(report.project_browser_mcp_config.configured, false);
  assert.equal(report.external_runtimes.codex_browser.declared, true);
  assert.equal(report.active_import_mode, 'codex_browser_capture');
  assert.deepEqual(report.fallback_order, ['codex_browser_capture', 'batch_url', 'text_or_file']);
});

test('安全清理只预览或删除已登记且超过期限的运行目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-cleanup-'));
  const oldRun = join(root, 'output', 'careerpilot', 'qa', 'run-old');
  const newRun = join(root, 'output', 'careerpilot', 'qa', 'run-new');
  const oldPdfRender = join(root, 'tmp', 'pdfs', 'render-old.png');
  const finalOutput = join(root, 'output', 'careerpilot', 'final', 'resume.pdf');
  for (const path of [oldRun, newRun, join(root, 'tmp', 'pdfs'), join(root, 'output', 'careerpilot', 'final')]) mkdirSync(path, { recursive: true });
  writeFileSync(join(oldRun, 'qa.txt'), 'old');
  writeFileSync(join(newRun, 'qa.txt'), 'new');
  writeFileSync(oldPdfRender, 'render');
  writeFileSync(finalOutput, 'formal');
  const now = new Date('2026-08-04T12:00:00.000Z');
  const old = new Date('2026-07-01T12:00:00.000Z');
  utimesSync(oldRun, old, old);
  utimesSync(join(oldRun, 'qa.txt'), old, old);
  utimesSync(oldPdfRender, old, old);

  const preview = cleanupCareerPilotRuns(root, { apply: false, olderThanDays: 7, now });
  assert.equal(preview.deleted.length, 0);
  assert.deepEqual(preview.targets.map((item) => item.relative_path), ['output/careerpilot/qa/run-old', 'tmp/pdfs/render-old.png']);
  assert.equal(existsSync(oldRun), true);

  const applied = cleanupCareerPilotRuns(root, { apply: true, olderThanDays: 7, now });
  assert.deepEqual(applied.deleted, ['output/careerpilot/qa/run-old', 'tmp/pdfs/render-old.png']);
  assert.equal(existsSync(oldRun), false);
  assert.equal(existsSync(newRun), true);
  assert.equal(existsSync(oldPdfRender), false);
  assert.equal(existsSync(finalOutput), true);
});

test('简历样式偏好只写入用户层并约束头像模板组合', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-style-'));
  assert.deepEqual(loadResumeStyle(root), DEFAULT_RESUME_STYLE);
  const photoStyle = structuredClone(DEFAULT_RESUME_STYLE);
  photoStyle.preset = 'compact-photo';
  photoStyle.photo.enabled = true;
  const saved = saveResumeStyle(root, photoStyle);
  assert.equal(saved.style.preset, 'compact-photo');
  assert.equal(existsSync(join(root, 'profile', 'resume-style.yml')), true);
  const invalid = structuredClone(photoStyle);
  invalid.photo.enabled = false;
  assert.throws(() => saveResumeStyle(root, invalid), (error) => error.code === 'RESUME_STYLE_INVALID');
});
