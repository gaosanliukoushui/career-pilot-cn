#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { inferJobPosting, evaluateJob, saveJobEvaluation } from './lib/careerpilot/job-core.mjs';
import { createResumeVariant, saveResumeVariant } from './lib/careerpilot/resume-core.mjs';
import {
  computeTailoringChange,
  createTailoringPreview,
  exportTailoredResume,
  validateTailoringPreview,
} from './lib/careerpilot/tailoring-core.mjs';

function setup(count = 10, withBlockingRule = false) {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-tailoring-'));
  mkdirSync(join(root, 'profile'), { recursive: true });
  const facts = Array.from({ length: count }, (_, index) => ({
    id: `project.fact.${index + 1}`,
    type: 'project',
    statement: `完成匿名项目模块 ${index + 1}`,
    status: 'confirmed',
    sensitivity: 'public',
    allowed_uses: ['resume', 'application_form', 'job_match'],
    evidence_ids: [`evidence.fact.${index + 1}`],
  }));
  const profile = {
    schema_version: 2,
    candidate: { display_name: '匿名候选人' },
    structured: { education: {}, language_certificates: [], credentials: [], preferences: {} },
    facts,
    evidence: facts.map((_, index) => ({
      id: `evidence.fact.${index + 1}`, kind: 'official_link', ref: `https://example.invalid/fact-${index + 1}`,
      strength: 'strong', verified_at: '2026-07-28T12:00:00.000Z',
    })),
  };
  writeFileSync(join(root, 'profile', 'candidate.yml'), yaml.dump(profile), 'utf8');
  const text = withBlockingRule
    ? '招聘单位：某中央企业\n岗位名称：信息岗\n学历要求：本科及以上'
    : '招聘单位：某中央企业\n岗位名称：信息岗\n校园招聘';
  const posting = inferJobPosting(text);
  const report = evaluateJob(root, posting);
  saveJobEvaluation(root, posting, report);
  const baseline = createResumeVariant(root, { template: 'soe-one-page', status: 'ready' });
  saveResumeVariant(root, baseline);
  return { root, posting, report, baseline };
}

test('未改动岗位简历比例为 0，且绑定岗位、基线和 Profile 哈希', () => {
  const { root, posting, baseline } = setup();
  const preview = createTailoringPreview(root, posting.id, { baseline_variant_id: baseline.id });
  assert.equal(preview.change_ratio, 0);
  assert.deepEqual(preview.changed_fact_ids, []);
  assert.equal(preview.allowed, true);
  assert.equal(preview.baseline_variant_id, baseline.id);
  assert.deepEqual(validateTailoringPreview(root, preview), { valid: true, errors: [] });
});

test('10 条基线事实删减 3 条恰好为 30%，允许继续导出', async () => {
  const { root, posting, baseline } = setup();
  const kept = baseline.fact_ids.slice(0, 7);
  const preview = createTailoringPreview(root, posting.id, {
    baseline_variant_id: baseline.id,
    fact_ids: kept,
    order: kept,
  });
  assert.equal(preview.change_ratio, 0.3);
  assert.equal(preview.changed_fact_ids.length, 3);
  assert.equal(preview.allowed, true);
  const exported = await exportTailoredResume(root, preview, 'md', 'output/careerpilot/tailored-30.md');
  const manifest = JSON.parse(readFileSync(`${exported.path}.manifest.json`, 'utf8'));
  assert.equal(manifest.job_id, posting.id);
  assert.equal(manifest.change_ratio, 0.3);
});

test('超过 30% 同时阻断确认和导出，且没有人工越权参数', async () => {
  const { root, posting, baseline } = setup();
  const kept = baseline.fact_ids.slice(0, 6);
  const preview = createTailoringPreview(root, posting.id, {
    baseline_variant_id: baseline.id,
    fact_ids: kept,
    order: kept,
  });
  assert.equal(preview.change_ratio, 0.4);
  assert.equal(preview.allowed, false);
  assert.deepEqual(preview.block_reasons, ['tailoring_limit_exceeded']);
  await assert.rejects(() => exportTailoredResume(root, preview, 'md', 'output/careerpilot/blocked.md'), (error) => error.code === 'TAILORING_BLOCKED');
  assert.equal(existsSync(join(root, 'output', 'careerpilot', 'blocked.md')), false);
});

test('相对顺序倒置会把参与倒置的唯一事实各计一次', () => {
  const { baseline } = setup(4);
  const proposed = structuredClone(baseline);
  proposed.order = [baseline.order[1], baseline.order[0], baseline.order[2], baseline.order[3]];
  const change = computeTailoringChange(baseline, proposed);
  assert.equal(change.change_ratio, 0.5);
  assert.deepEqual(new Set(change.changed_fact_ids), new Set([baseline.order[0], baseline.order[1]]));
});

test('岗位资格 unknown 时简历定制被阻断，带原因的资格覆盖才解除资格门槛', () => {
  const blocked = setup(10, true);
  const preview = createTailoringPreview(blocked.root, blocked.posting.id, { baseline_variant_id: blocked.baseline.id });
  assert.deepEqual(preview.block_reasons, ['eligibility_blocked']);

  const overriddenReport = evaluateJob(blocked.root, blocked.posting, { override_reason: '招聘方确认可先投递后补学历材料' });
  saveJobEvaluation(blocked.root, blocked.posting, overriddenReport);
  const allowed = createTailoringPreview(blocked.root, blocked.posting.id, { baseline_variant_id: blocked.baseline.id });
  assert.equal(allowed.allowed, true);
});

test('草稿简历不能作为岗位定制基线', () => {
  const { root, posting } = setup();
  const draft = createResumeVariant(root, { template: 'soe-one-page', status: 'draft' });
  saveResumeVariant(root, draft);
  assert.throws(
    () => createTailoringPreview(root, posting.id, { baseline_variant_id: draft.id }),
    (error) => error.code === 'BASELINE_NOT_APPROVED',
  );
});

