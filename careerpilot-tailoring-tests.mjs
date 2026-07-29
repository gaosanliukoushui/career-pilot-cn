#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { confirmJobPosting, inferJobPosting, evaluateJob, saveJobEvaluation } from './lib/careerpilot/job-core.mjs';
import { confirmResumeVariant, createResumeVariant, saveResumeVariant } from './lib/careerpilot/resume-core.mjs';
import {
  computeTailoringChange,
  createTailoringPreview,
  exportTailoredResume,
  generateTailoringRewriteCandidates,
  validateTailoringPreview,
} from './lib/careerpilot/tailoring-core.mjs';

function setup(count = 10, withBlockingRule = false) {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-tailoring-'));
  mkdirSync(join(root, 'profile'), { recursive: true });
  const facts = Array.from({ length: count }, (_, index) => ({
    id: `project.fact.${index + 1}`,
    type: 'project',
    statement: index === 0 ? '完成匿名项目模块 1；整理交付材料' : `完成匿名项目模块 ${index + 1}`,
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
    : '招聘单位：某中央企业\n岗位名称：信息岗\n校园招聘\n岗位职责：整理交付材料';
  const pendingPosting = inferJobPosting(text);
  pendingPosting.rules = pendingPosting.rules.map((rule) => ({ ...rule, confirmation_status: 'confirmed' }));
  const posting = confirmJobPosting(pendingPosting);
  const report = evaluateJob(root, posting);
  const paths = saveJobEvaluation(root, posting, report);
  const baseline = confirmResumeVariant(root, createResumeVariant(root, { template: 'soe-one-page' })).variant;
  return { root, posting, report, baseline, paths };
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

test('岗位候选改写必须逐条接受或拒绝，并展示前后事实与确认状态', async () => {
  const { root, posting, baseline } = setup();
  const pending = createTailoringPreview(root, posting.id, {
    baseline_variant_id: baseline.id,
    rewrite_reviews: [{ fact_id: baseline.fact_ids[0], proposed_statement: '整理交付材料；完成匿名项目模块 1', status: 'pending' }],
  });
  assert.equal(pending.allowed, false);
  assert.ok(pending.block_reasons.includes('rewrite_confirmation_pending'));
  assert.deepEqual(pending.changes.find((item) => item.type === 'rewritten'), {
    fact_id: baseline.fact_ids[0], type: 'rewritten', before: '完成匿名项目模块 1；整理交付材料',
    after: '整理交付材料；完成匿名项目模块 1', confirmation_status: 'pending',
  });
  await assert.rejects(() => exportTailoredResume(root, pending, 'md', 'output/careerpilot/pending-rewrite.md'), (error) => error.code === 'TAILORING_BLOCKED');

  const accepted = createTailoringPreview(root, posting.id, {
    baseline_variant_id: baseline.id,
    rewrite_reviews: [{ fact_id: baseline.fact_ids[0], proposed_statement: '整理交付材料；完成匿名项目模块 1', status: 'accepted' }],
  });
  assert.equal(accepted.allowed, true);
  assert.equal(accepted.change_ratio, 0.1);
  assert.equal(accepted.changes.find((item) => item.type === 'rewritten').confirmation_status, 'confirmed');
});

test('岗位候选改写由岗位原文相关性生成且只能重排原 Fact 分句', () => {
  const { root, posting, baseline } = setup();
  const result = generateTailoringRewriteCandidates(root, posting.id, baseline.id);
  assert.deepEqual(result.candidates[0], {
    fact_id: baseline.fact_ids[0],
    original_statement: '完成匿名项目模块 1；整理交付材料',
    proposed_statement: '整理交付材料；完成匿名项目模块 1',
    status: 'pending',
    rationale: '仅重排原事实分句，将与岗位原文重叠更高的内容前置',
  });
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

test('岗位、Profile 和主简历任一变化都会让既有岗位简历预览过期', () => {
  const jobChanged = setup();
  const jobPreview = createTailoringPreview(jobChanged.root, jobChanged.posting.id, { baseline_variant_id: jobChanged.baseline.id });
  const changedReport = JSON.parse(readFileSync(jobChanged.paths.match_path, 'utf8'));
  changedReport.job_sha256 = 'f'.repeat(64);
  writeFileSync(jobChanged.paths.match_path, `${JSON.stringify(changedReport, null, 2)}\n`, 'utf8');
  assert.ok(validateTailoringPreview(jobChanged.root, jobPreview).errors.some((item) => item.code === 'job_changed_since_preview'));

  const profileChanged = setup();
  const profilePreview = createTailoringPreview(profileChanged.root, profileChanged.posting.id, { baseline_variant_id: profileChanged.baseline.id });
  const profilePath = join(profileChanged.root, 'profile', 'candidate.yml');
  const profile = yaml.load(readFileSync(profilePath, 'utf8'));
  profile.facts[0].statement = '变更后的已确认项目事实';
  writeFileSync(profilePath, yaml.dump(profile), 'utf8');
  assert.ok(validateTailoringPreview(profileChanged.root, profilePreview).errors.some((item) => item.code === 'profile_changed_since_preview'));

  const baselineChanged = setup();
  const baselinePreview = createTailoringPreview(baselineChanged.root, baselineChanged.posting.id, { baseline_variant_id: baselineChanged.baseline.id });
  const baselinePath = join(baselineChanged.root, 'profile', 'variants', `${baselineChanged.baseline.id}.json`);
  const storedBaseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  storedBaseline.status = 'exported';
  writeFileSync(baselinePath, `${JSON.stringify(storedBaseline, null, 2)}\n`, 'utf8');
  assert.ok(validateTailoringPreview(baselineChanged.root, baselinePreview).errors.some((item) => item.code === 'baseline_changed_since_preview'));
});
