#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectRuntimeCapabilities } from './lib/careerpilot/runtime-core.mjs';
import { cleanupCareerPilotRuns } from './lib/careerpilot/cleanup-core.mjs';
import {
  DEFAULT_RESUME_STYLE,
  getResumeStyleCatalog,
  loadResumeStyle,
  saveResumeStyle,
  validateResumeStyle,
} from './lib/careerpilot/resume-style-core.mjs';

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

test('简历策略目录收敛为央国企、互联网和科研三种内容策略', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-style-'));
  assert.deepEqual(loadResumeStyle(root), DEFAULT_RESUME_STYLE);
  const catalog = getResumeStyleCatalog(root);
  assert.equal(catalog.styles.length, 3);
  assert.equal(catalog.editorial_policy.source_scope, 'reference_layout_and_editorial_patterns_only');
  assert.match(catalog.editorial_policy.fact_boundary, /publishable CandidateProfile Fact/);
  assert.deepEqual(catalog.content_strategies.strategies.map((item) => item.id), [
    'soe-outcome',
    'internet-engineering',
    'research-academic',
  ]);
  const soe = catalog.content_strategies.strategies.find((item) => item.id === 'soe-outcome');
  assert.deepEqual(soe.experience_formula, ['问题或任务', '个人责任', '关键行动与协同', '交付或可验证结果']);
  assert.match(soe.technology_rule, /解决问题所必需/);
  assert.match(soe.outcome_definition, /交付|验收|稳定运行/);
  assert.deepEqual(catalog.styles.map((item) => item.id), [
    'soe-outcome',
    'internet-engineering',
    'research-academic',
  ]);
  assert.deepEqual(catalog.styles.map((item) => item.content_strategy_id), catalog.styles.map((item) => item.id));
  assert.equal(catalog.recommendation.style_id, 'soe-outcome');
  assert.ok(catalog.recommendation.reasons.length > 0);
  const photoStyle = structuredClone(DEFAULT_RESUME_STYLE);
  photoStyle.theme = 'research-academic';
  photoStyle.photo.enabled = true;
  photoStyle.page_budget = 1;
  photoStyle.emphasis = 'research';
  const saved = saveResumeStyle(root, photoStyle);
  assert.equal(saved.style.theme, 'research-academic');
  assert.equal(saved.style.photo.enabled, true);
  assert.equal(existsSync(join(root, 'profile', 'resume-style.yml')), true);
  const invalid = structuredClone(photoStyle);
  invalid.theme = 'unknown-theme';
  assert.throws(() => saveResumeStyle(root, invalid), (error) => error.code === 'RESUME_STYLE_INVALID');
});

test('旧版样式配置读取时确定性迁移且不改写用户文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-style-v1-'));
  mkdirSync(join(root, 'profile'), { recursive: true });
  const legacy = [
    'schema_version: 1',
    'preset: compact-photo',
    'density: full',
    'font_family: Microsoft YaHei',
    'font_size_pt: 9.5',
    'page_margin_cm: 0.9',
    'section_order: [教育经历, 项目经历, 专业技能]',
    'project_bullet_limit: 4',
    'photo:',
    '  enabled: true',
    '  crop: center-3x4',
    '  width_cm: 2.4',
    '  height_cm: 3.2',
    '',
  ].join('\n');
  const path = join(root, 'profile', 'resume-style.yml');
  writeFileSync(path, legacy, 'utf8');
  const migrated = loadResumeStyle(root);
  assert.equal(migrated.schema_version, 2);
  assert.equal(migrated.theme, 'soe-outcome');
  assert.equal(migrated.page_budget, 1);
  assert.equal(migrated.photo.enabled, true);
  assert.equal(validateResumeStyle(migrated).valid, true);
  assert.equal(readFileSync(path, 'utf8'), legacy);
});

test('V3.2 五主题配置只读迁移到三种内容策略且不改写用户文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-style-v32-'));
  mkdirSync(join(root, 'profile'), { recursive: true });
  const legacy = [
    'schema_version: 2',
    'theme: technical-minimal',
    'density: balanced',
    'page_budget: 2',
    'emphasis: technical',
    'font_family: Noto Sans CJK SC',
    'font_size_pt: 9.5',
    'page_margin_cm: 1',
    'section_order: [实习与工作经历, 项目经历, 专业技能, 教育经历]',
    'project_bullet_limit: 4',
    'photo:',
    '  enabled: false',
    '  crop: center-3x4',
    '  width_cm: 2.4',
    '  height_cm: 3.2',
    '',
  ].join('\n');
  const path = join(root, 'profile', 'resume-style.yml');
  writeFileSync(path, legacy, 'utf8');
  assert.equal(loadResumeStyle(root).theme, 'internet-engineering');
  assert.equal(readFileSync(path, 'utf8'), legacy);
});

test('内容诊断只统计已有 Fact 的经历与结果覆盖，不替候选人补写结果', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-content-audit-'));
  mkdirSync(join(root, 'profile'), { recursive: true });
  writeFileSync(join(root, 'profile', 'candidate.yml'), readFileSync(join(import.meta.dirname, 'examples', 'cn-profile', 'resume-style-preview.yml')));
  const audit = getResumeStyleCatalog(root).content_audit;
  assert.equal(audit.experience_fact_count, 8);
  assert.equal(audit.result_fact_count, 3);
  assert.equal(audit.result_coverage_proxy, 0.375);
  assert.equal(audit.inference_boundary, 'portfolio_level_proxy_not_fact_rewrite');
  assert.ok(audit.guidance.some((item) => item.includes('不会编造')));
});
