#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';
import {
  buildProjectInterviewPackRequest,
  buildProjectInterviewReviewRequest,
  listProjectInterviewSources,
  validateProjectInterviewPack,
  validateProjectInterviewReview,
} from './lib/careerpilot/project-interview-core.mjs';

const verifiedAt = '2026-08-10T12:00:00.000Z';

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function projectFacts(slug, name, options = {}) {
  const evidenceId = `evidence.${slug}`;
  return [{
    id: `project.${slug}.summary`,
    type: 'project',
    statement: `${name}｜${options.kind || '个人项目'}｜示例技术栈`,
    status: 'confirmed',
    sensitivity: 'public',
    allowed_uses: ['resume', 'interview'],
    evidence_ids: [evidenceId],
  }, {
    id: `project.${slug}.detail`,
    type: 'project',
    statement: `${name} 已确认的项目行动与结果`,
    status: options.detailStatus || 'confirmed',
    sensitivity: options.detailSensitivity || 'public',
    allowed_uses: options.detailUses || ['resume', 'interview'],
    evidence_ids: [evidenceId],
  }];
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-project-interview-'));
  mkdirSync(join(root, 'profile', 'variants'), { recursive: true });
  mkdirSync(join(root, 'output', 'careerpilot'), { recursive: true });

  const slugs = ['smartrag', 'smart_education', 'novahub', 'recommendation'];
  const names = ['SmartRAG', 'Smart Education', 'NovaHub', '推荐系统'];
  const facts = slugs.flatMap((slug, index) => projectFacts(slug, names[index], slug === 'novahub'
    ? { detailUses: ['resume'] }
    : {}));
  const evidence = slugs.map((slug) => ({
    id: `evidence.${slug}`,
    kind: 'user_confirmation',
    ref: `confirmation:${slug}`,
    strength: 'ordinary',
    verified_at: verifiedAt,
  }));
  writeFileSync(join(root, 'profile', 'candidate.yml'), yaml.dump({
    schema_version: 2,
    candidate: { display_name: '匿名候选人' },
    structured: { education: {}, language_certificates: [], credentials: [], preferences: {} },
    facts,
    evidence,
  }), 'utf8');

  const selectedFactIds = facts
    .filter((fact) => !fact.id.startsWith('project.recommendation.'))
    .map((fact) => fact.id);
  const variantId = 'resume.soe-one-page.interview-fixture';
  writeFileSync(join(root, 'profile', 'variants', `${variantId}.json`), JSON.stringify({
    id: variantId,
    template: 'soe-one-page',
    target_job_title: 'AI 应用开发工程师',
    order: selectedFactIds,
    fact_ids: selectedFactIds,
    rewrites: [],
    status: 'ready',
    confirmation: { status: 'confirmed', confirmed_at: '2026-08-10T11:00:00.000Z' },
  }), 'utf8');

  const pdf = Buffer.from('%PDF-1.7\nfixture\n');
  const output = 'output/careerpilot/anonymous-three-projects.pdf';
  writeFileSync(join(root, ...output.split('/')), pdf);
  const manifestPath = join(root, 'output', 'careerpilot', 'anonymous-three-projects.pdf.manifest.json');
  writeFileSync(manifestPath, JSON.stringify({
    schema_version: 1,
    variant_id: variantId,
    template: 'soe-one-page',
    fact_ids: selectedFactIds,
    output,
    content_sha256: sha256(pdf),
    generated_at: '2026-08-10T12:00:00.000Z',
    qa: {
      page_count: 1,
      page_budget: 1,
      text_layer: 'verified',
      render_status: 'verified',
      truncation: 'verified',
      overlap: 'verified',
      whitespace: 'verified',
    },
  }), 'utf8');
  return root;
}

test('项目面试目录只采用最近已验证简历中的三个项目，不从全量 Profile 补第四个', () => {
  const root = createFixture();
  const catalog = listProjectInterviewSources(root);

  assert.equal(catalog.sources.length, 1);
  assert.equal(catalog.default_source_id, catalog.sources[0].id);
  assert.equal(catalog.sources[0].kind, 'verified_export');
  assert.deepEqual(catalog.sources[0].projects.map((project) => project.name), [
    'SmartRAG', 'Smart Education', 'NovaHub',
  ]);
  assert.doesNotMatch(JSON.stringify(catalog), /推荐系统/);
});

test('项目面试上下文只发送已确认、有证据且获准 interview 使用的项目事实', () => {
  const root = createFixture();
  const catalog = listProjectInterviewSources(root);
  const source = catalog.sources[0];
  const request = buildProjectInterviewPackRequest(root, {
    source_id: source.id,
    project_id: 'novahub',
    target_role: 'Java 后端开发',
  });

  assert.equal(request.context.project.name, 'NovaHub');
  assert.deepEqual(request.context.project.facts.map((fact) => fact.id), ['project.novahub.summary']);
  assert.match(request.prompt, /Java 后端开发/);
  assert.match(request.prompt, /候选人事实只能来自/);
  assert.match(request.prompt, /project\.novahub\.summary/);
  assert.doesNotMatch(request.prompt, /已确认的项目行动与结果/);
  assert.doesNotMatch(request.prompt, /SmartRAG|推荐系统/);
});

function validPack(projectId, factId) {
  const categories = ['overview', 'ownership', 'architecture', 'mechanism', 'tradeoff', 'reliability'];
  return {
    schema_version: 1,
    phase: 'pack',
    project_id: projectId,
    target_role: 'Java 后端开发',
    analysis: {
      positioning: '用已确认事实说明项目定位',
      interviewer_focus: ['本人责任', '方案取舍', '验证与边界'],
      claim_boundaries: ['只陈述当前简历已确认内容'],
      preparation_priorities: ['先讲问题，再讲责任与验证'],
      source_fact_ids: [factId],
    },
    opening_answer: {
      headline: '先说项目解决的问题',
      answer: '该项目围绕已确认的项目内容展开，我会说明自己的责任、方案、验证和当前边界。',
      source_fact_ids: [factId],
      unknowns: ['当前简历事实未覆盖具体性能指标'],
    },
    questions: categories.map((category, index) => ({
      id: `q${index + 1}`,
      category,
      depth: index < 2 ? 'foundation' : index < 5 ? 'deep' : 'pressure',
      question: `请说明项目的${category}。`,
      intent: '核实候选人是否真正理解并参与该项目。',
      scoring_points: ['先给结论', '说明本人责任', '给出验证与边界'],
      reference_answer: {
        headline: '结论先行',
        points: ['项目内容来自已确认事实', '回答保留当前边界'],
        source_fact_ids: [factId],
        unknowns: [],
      },
      follow_ups: ['如果关键环节失败，你会如何定位？'],
    })),
  };
}

test('AI 训练包必须覆盖六类题型且所有分析与参考答案只能引用当前项目 Fact', () => {
  const root = createFixture();
  const source = listProjectInterviewSources(root).sources[0];
  const input = { source_id: source.id, project_id: 'novahub', target_role: 'Java 后端开发' };
  const pack = validPack('novahub', 'project.novahub.summary');

  assert.deepEqual(validateProjectInterviewPack(root, input, pack), { valid: true, errors: [], pack });

  const poisoned = structuredClone(pack);
  poisoned.questions[0].reference_answer.source_fact_ids = ['project.smartrag.summary'];
  const rejected = validateProjectInterviewPack(root, input, poisoned);
  assert.equal(rejected.valid, false);
  assert.ok(rejected.errors.some((error) => error.code === 'fact_reference_not_allowed'));

  const overclaimed = structuredClone(pack);
  overclaimed.opening_answer.answer = '这是我独立完成的个人项目，从架构到代码都是我一个人做的。';
  const ownershipNormalized = validateProjectInterviewPack(root, input, overclaimed);
  assert.equal(ownershipNormalized.valid, true);
  assert.doesNotMatch(ownershipNormalized.pack.opening_answer.answer, /我独立完成|我一个人做/);
  assert.match(ownershipNormalized.pack.opening_answer.answer, /具体责任|已确认事实/);

  const safeBoundaryReminder = structuredClone(pack);
  safeBoundaryReminder.analysis.claim_boundaries = ['不得输出身份证号码、家庭住址或联系方式'];
  assert.equal(validateProjectInterviewPack(root, input, safeBoundaryReminder).valid, true);

  const leakedIdentity = structuredClone(pack);
  leakedIdentity.opening_answer.answer += ' 联系邮箱 candidate@example.com。';
  const identityRejected = validateProjectInterviewPack(root, input, leakedIdentity);
  assert.equal(identityRejected.valid, false);
  assert.ok(identityRejected.errors.some((error) => error.code === 'forbidden_sensitive_content'));
});

function validReview(projectId, factId, question) {
  return {
    schema_version: 1,
    phase: 'feedback',
    project_id: projectId,
    question,
    status: 'gap',
    score: 56,
    dimension_scores: { structure: 12, ownership: 12, technical_depth: 12, evidence: 8, boundary: 12 },
    landed: ['先说明了项目方向'],
    sharpen: [{ issue: '使用了当前事实无法核验的指标', repair: '删除指标，改为描述可证明的行动与验证方式' }],
    unsupported_claims: [{ claim: '吞吐提升 80%', reason: '当前项目 Fact 未包含该指标' }],
    stronger_version: {
      headline: '只保留可核验结论',
      answer: '这个项目的回答应先说明已确认的项目定位，再讲本人责任、方案、验证和边界。',
      source_fact_ids: [factId],
      unknowns: ['具体吞吐提升比例需要本人补充证据'],
    },
    follow_up_question: '如果不能使用这个指标，你会用什么证据证明方案有效？',
  };
}

test('模拟反馈必须标出回答中新出现的指标，且更强版本不得复用未核实主张', () => {
  const root = createFixture();
  const source = listProjectInterviewSources(root).sources[0];
  const input = {
    source_id: source.id,
    project_id: 'novahub',
    target_role: 'Java 后端开发',
    question: '请介绍这个项目中最关键的技术取舍。',
    answer: '我做完以后吞吐提升 80%，所以这个方案很有效。',
  };
  const request = buildProjectInterviewReviewRequest(root, input);
  assert.match(request.prompt, /吞吐提升 80%/);
  assert.match(request.prompt, /不得直接写入更强版本/);

  const review = validReview('novahub', 'project.novahub.summary', input.question);
  assert.deepEqual(validateProjectInterviewReview(root, input, review), { valid: true, errors: [], review });

  const normalized = structuredClone(review);
  normalized.question = '模型擅自改写的问题';
  normalized.score = 99;
  normalized.unsupported_claims = [];
  const normalizedResult = validateProjectInterviewReview(root, input, normalized);
  assert.equal(normalizedResult.valid, true);
  assert.equal(normalizedResult.review.question, input.question);
  assert.equal(normalizedResult.review.score, 56);
  assert.ok(normalizedResult.review.unsupported_claims.some((item) => item.claim.includes('80%')));

  const reused = structuredClone(review);
  reused.stronger_version.answer += '并且吞吐提升 80%。';
  assert.ok(validateProjectInterviewReview(root, input, reused).errors
    .some((error) => error.code === 'unsupported_claim_reused'));

  const boundaryOnly = structuredClone(review);
  boundaryOnly.stronger_version.answer += '当前不使用吞吐提升 80% 这一未核实说法。';
  assert.equal(validateProjectInterviewReview(root, input, boundaryOnly).valid, true);
});

test('careerpilot CLI 通过只读命令公开同一个项目目录', () => {
  const root = createFixture();
  const output = execFileSync(process.execPath, [
    join(import.meta.dirname, 'careerpilot.mjs'), 'interview-projects', '--root', root,
  ], { encoding: 'utf8' });
  const catalog = JSON.parse(output);
  assert.deepEqual(catalog.sources[0].projects.map((project) => project.id), [
    'smartrag', 'smart_education', 'novahub',
  ]);
});
