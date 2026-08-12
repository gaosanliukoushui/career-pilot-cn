#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';
import { exactStatementSequencePresent } from './lib/careerpilot/artifact-qa-core.mjs';
import { confirmResumeVariant, createResumeVariant } from './lib/careerpilot/resume-core.mjs';
import {
  buildDeterministicProjectInterviewPack,
  buildDeterministicProjectInterviewReview,
  buildProjectInterviewPackRequest,
  buildProjectInterviewReviewRequest,
  listProjectInterviewSources,
  validateProjectInterviewPack,
  validateProjectInterviewReview,
} from './lib/careerpilot/project-interview-core.mjs';

const verifiedAt = '2026-08-10T12:00:00.000Z';

test('旧 PDF 语义复验要求完整项目序列，不被否定前缀或富文本切分绕过', () => {
  const expected = ['项目经历', 'own the core architecture', 'implemented validation', '专业技能'];
  assert.equal(exactStatementSequencePresent(['项目经历', 'I did not ', 'own the core architecture', 'implemented validation', '专业技能'], expected), false);
  assert.equal(exactStatementSequencePresent(['项目经历', 'own the core ', 'architecture', 'implemented ', 'validation', 'the statement above is not my work', '专业技能'], expected), false);
  assert.equal(exactStatementSequencePresent(['项目经历', 'own the core ', 'architecture', 'implemented ', 'validation', '专业技能'], expected), true);
  assert.equal(exactStatementSequencePresent(['own the core architecture'], ['ERP']), false);
});

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
    statement: options.detailStatement || `${name} 已确认的项目行动与结果`,
    status: options.detailStatus || 'confirmed',
    sensitivity: options.detailSensitivity || 'public',
    allowed_uses: options.detailUses || ['resume', 'interview'],
    evidence_ids: [evidenceId],
  }];
}

function createFixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-project-interview-'));
  mkdirSync(join(root, 'profile', 'variants'), { recursive: true });
  mkdirSync(join(root, 'output', 'careerpilot'), { recursive: true });

  const slugs = ['project_alpha', 'project_beta', 'project_gamma', 'recommendation'];
  const names = ['项目甲', '项目乙', '项目丙', '推荐系统'];
  const facts = [...slugs.flatMap((slug, index) => projectFacts(slug, names[index], slug === 'project_gamma'
    ? { detailUses: ['resume'] }
    : slug === 'project_alpha' ? { detailStatement: options.projectAlphaDetailStatement || '在项目甲中实现任务暂停模块' } : {})), ...(options.extraFacts || [])];
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
  const draft = createResumeVariant(root, {
    id: variantId,
    template: 'soe-one-page',
    target_job_title: 'AI 应用开发工程师',
    order: selectedFactIds,
    fact_ids: selectedFactIds,
    rewrites: options.rewrites || [],
  });
  const { variant } = confirmResumeVariant(root, draft);

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
    variant_confirmation_sha256: variant.confirmation.preview_sha256,
    generated_at: new Date(Math.max(Date.parse(variant.confirmation.confirmed_at), Date.parse(verifiedAt)) + 1).toISOString(),
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

test('项目面试目录只采用最近已验证简历中的三个项目，不从全量 Profile 补第四个', async () => {
  const root = createFixture();
  const catalog = await listProjectInterviewSources(root);

  assert.equal(catalog.sources.length, 1);
  assert.equal(catalog.default_source_id, catalog.sources[0].id);
  assert.equal(catalog.sources[0].kind, 'verified_export');
  assert.deepEqual(catalog.sources[0].projects.map((project) => project.name), [
    '项目甲', '项目乙', '项目丙',
  ]);
  assert.doesNotMatch(JSON.stringify(catalog), /推荐系统/);
});

test('项目面试目录拒绝已过期 ResumeVariant 和与版本不一致的 manifest', async () => {
  const staleRoot = createFixture();
  const profilePath = join(staleRoot, 'profile', 'candidate.yml');
  const profile = yaml.load(readFileSync(profilePath, 'utf8'));
  profile.candidate.display_name = '资料已变化';
  writeFileSync(profilePath, yaml.dump(profile), 'utf8');
  assert.equal((await listProjectInterviewSources(staleRoot)).sources.length, 0);

  const mismatchedRoot = createFixture();
  const manifestPath = join(mismatchedRoot, 'output', 'careerpilot', 'anonymous-three-projects.pdf.manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.fact_ids = manifest.fact_ids.slice(1);
  writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  assert.equal((await listProjectInterviewSources(mismatchedRoot)).sources.length, 0);

  const reboundRoot = createFixture();
  const reboundManifestPath = join(reboundRoot, 'output', 'careerpilot', 'anonymous-three-projects.pdf.manifest.json');
  const reboundManifest = JSON.parse(readFileSync(reboundManifestPath, 'utf8'));
  const storedVariantPath = join(reboundRoot, 'profile', 'variants', `${reboundManifest.variant_id}.json`);
  const storedVariant = JSON.parse(readFileSync(storedVariantPath, 'utf8'));
  const reboundDraft = createResumeVariant(reboundRoot, {
    id: storedVariant.id,
    template: storedVariant.template,
    target_job_title: storedVariant.target_job_title,
    fact_ids: storedVariant.fact_ids,
    order: storedVariant.order,
    rewrites: [{
      fact_id: 'project.project_alpha.summary',
      proposed_statement: '项目甲 个人项目 示例技术栈',
      accepted: true,
    }],
  });
  confirmResumeVariant(reboundRoot, reboundDraft);
  assert.equal((await listProjectInterviewSources(reboundRoot)).sources.length, 0);
});

test('项目面试目录拒绝伪装成完整正式产物的不完整 v2 manifest', async () => {
  const root = createFixture();
  const manifestPath = join(root, 'output', 'careerpilot', 'anonymous-three-projects.pdf.manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.schema_version = 2;
  writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  assert.equal((await listProjectInterviewSources(root)).sources.length, 0);
});

test('项目面试目录拒绝信任根目录本身是 symlink 或 Windows junction', async (context) => {
  const sourceRoot = createFixture();
  const linkedRoot = mkdtempSync(join(tmpdir(), 'careerpilot-project-interview-link-'));
  mkdirSync(join(linkedRoot, 'output'), { recursive: true });
  try {
    symlinkSync(
      join(sourceRoot, 'output', 'careerpilot'),
      join(linkedRoot, 'output', 'careerpilot'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (error) {
    context.skip(`symlink/junction unavailable: ${error.message}`);
    return;
  }
  assert.equal((await listProjectInterviewSources(linkedRoot)).sources.length, 0);
});

test('项目面试上下文只发送已确认、有证据且获准 interview 使用的项目事实', async () => {
  const root = createFixture();
  const catalog = await listProjectInterviewSources(root);
  const source = catalog.sources[0];
  const request = await buildProjectInterviewPackRequest(root, {
    source_id: source.id,
    project_id: 'project_gamma',
    target_role: 'Java 后端开发',
  });

  assert.equal(request.context.project.name, '项目丙');
  assert.deepEqual(request.context.project.facts.map((fact) => fact.id), ['project.project_gamma.summary']);
  assert.match(request.prompt, /Java 后端开发/);
  assert.match(request.prompt, /候选人事实只能来自/);
  assert.match(request.prompt, /project\.project_gamma\.summary/);
  assert.doesNotMatch(request.prompt, /已确认的项目行动与结果/);
  assert.doesNotMatch(request.prompt, /项目甲|推荐系统/);
  assert.equal(request.proposal_schema.properties.project_id.const, 'project_gamma');
  assert.equal(request.proposal_schema.properties.target_role.const, 'Java 后端开发');
  assert.deepEqual(
    request.proposal_schema.properties.questions.prefixItems.map((item) => [
      item.properties.id.const,
      item.properties.category.const,
      item.properties.depth.const,
      item.properties.answer_facts.maxItems,
    ]),
    [
      ['q1', 'overview', 'foundation', 1],
      ['q2', 'ownership', 'foundation', 0],
      ['q3', 'architecture', 'deep', 0],
      ['q4', 'mechanism', 'deep', 0],
      ['q5', 'tradeoff', 'deep', 0],
      ['q6', 'reliability', 'pressure', 0],
    ],
  );
});

test('即使敏感值被误标为 public，也不得进入项目面试上下文', async () => {
  assert.throws(() => createFixture({
    extraFacts: [{
      id: 'project.project_alpha.address',
      type: 'project',
      statement: '北京市海淀区中关村大街27号',
      status: 'confirmed',
      sensitivity: 'public',
      allowed_uses: ['resume', 'interview'],
      evidence_ids: ['evidence.project_alpha'],
    }],
  }), (error) => error?.code === 'FACT_NOT_PUBLISHABLE');

  const root = createFixture({
    extraFacts: [{
      id: 'project.project_alpha.contact',
      type: 'project',
      statement: '联系邮箱 candidate@example.com',
      status: 'confirmed',
      sensitivity: 'public',
      allowed_uses: ['resume', 'interview'],
      evidence_ids: ['evidence.project_alpha'],
    }],
  });
  const source = (await listProjectInterviewSources(root)).sources[0];
  const request = await buildProjectInterviewPackRequest(root, {
    source_id: source.id,
    project_id: 'project_alpha',
  });

  assert.doesNotMatch(JSON.stringify(request.context), /candidate@example\.com/);
  assert.doesNotMatch(request.prompt, /candidate@example\.com/);
  assert.doesNotMatch(request.prompt, /project\.project_alpha\.contact/);
});

function factRef(context, factId) {
  const fact = context.project.facts.find((item) => item.id === factId);
  assert.ok(fact, `missing fixture fact ${factId}`);
  return { fact_id: fact.id, fact_sha256: fact.statement_sha256 };
}

function validPackPlan(context, projectId, factId) {
  const categories = ['overview', 'ownership', 'architecture', 'mechanism', 'tradeoff', 'reliability'];
  const ref = factRef(context, factId);
  return {
    schema_version: 1,
    phase: 'pack_plan',
    project_id: projectId,
    target_role: 'Java 后端开发',
    analysis_facts: [ref],
    opening_sections: [
      { stage: 'scenario', fact: ref, verification_topic: null },
      { stage: 'responsibility', fact: null, verification_topic: 'responsibility' },
      { stage: 'solution', fact: null, verification_topic: 'implementation' },
      { stage: 'validation', fact: null, verification_topic: 'validation' },
    ],
    questions: categories.map((category, index) => ({
      id: `q${index + 1}`,
      category,
      depth: index < 2 ? 'foundation' : index < 5 ? 'deep' : 'pressure',
      answer_facts: category === 'overview' ? [ref] : [],
      unknown_topics: index === 1 ? ['responsibility', 'collaboration'] : ['validation'],
    })),
  };
}

test('AI 训练包只能选择带哈希的 Fact，候选人答案由服务端用完整 Fact 渲染', async () => {
  const root = createFixture();
  const source = (await listProjectInterviewSources(root)).sources[0];
  const input = { source_id: source.id, project_id: 'project_gamma', target_role: 'Java 后端开发' };
  const request = await buildProjectInterviewPackRequest(root, input);
  const plan = validPackPlan(request.context, 'project_gamma', 'project.project_gamma.summary');
  const result = await validateProjectInterviewPack(root, input, plan);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.match(result.pack.analysis.positioning, new RegExp(request.context.project.facts[0].statement));
  assert.match(result.pack.opening_answer.answer, /场景与问题.*本人责任.*方案与取舍.*验证.*边界/s);
  assert.equal(result.pack.questions.length, 6);
  assert.equal(result.pack.questions[0].reference_answer.points.length, 5);
  assert.match(result.pack.questions[0].reference_answer.points[0], new RegExp(request.context.project.facts[0].statement));
  assert.match(result.pack.questions[1].reference_answer.points[1], /未明确本人动作|不能从.*项目.*推导责任/);
  assert.doesNotMatch(JSON.stringify(result.pack.questions[1].reference_answer), /本人责任｜已确认 Fact/);
  assert.doesNotMatch(JSON.stringify(result.pack), /Celery|吞吐提升 80%|主导核心架构/);
  assert.match(result.pack.questions[5].intent, /不从.*推导.*尚未上线/);
  assert.match(result.pack.questions[2].question, /未出现的组件|待核实/);

  const wrongProject = structuredClone(plan);
  wrongProject.questions[0].answer_facts[0] = { ...wrongProject.questions[0].answer_facts[0], fact_id: 'project.project_alpha.summary' };
  assert.ok((await validateProjectInterviewPack(root, input, wrongProject)).errors.some((error) => error.code === 'fact_reference_not_allowed'));

  const staleHash = structuredClone(plan);
  staleHash.opening_sections[0].fact.fact_sha256 = '0'.repeat(64);
  assert.ok((await validateProjectInterviewPack(root, input, staleHash)).errors.some((error) => error.code === 'fact_hash_mismatch'));

  const freeText = structuredClone(plan);
  freeText.opening_answer = { answer: '吞吐提升 80%' };
  assert.ok((await validateProjectInterviewPack(root, input, freeText)).errors.some((error) => error.code === 'schema_invalid'));

  const wrongOpeningStage = structuredClone(plan);
  wrongOpeningStage.opening_sections[0] = { stage: 'scenario', fact: null, verification_topic: 'implementation' };
  wrongOpeningStage.opening_sections[1] = { stage: 'responsibility', fact: factRef(request.context, 'project.project_gamma.summary'), verification_topic: null };
  assert.ok((await validateProjectInterviewPack(root, input, wrongOpeningStage)).errors.some((error) => error.code === 'fact_stage_mismatch'));

  const wrongQuestionStage = structuredClone(plan);
  wrongQuestionStage.questions[1].answer_facts = [factRef(request.context, 'project.project_gamma.summary')];
  assert.ok((await validateProjectInterviewPack(root, input, wrongQuestionStage)).errors.some((error) => error.code === 'fact_stage_mismatch'));

  const wrongOrder = structuredClone(plan);
  [wrongOrder.questions[0], wrongOrder.questions[1]] = [wrongOrder.questions[1], wrongOrder.questions[0]];
  assert.ok((await validateProjectInterviewPack(root, input, wrongOrder)).errors.some((error) => error.code === 'question_coverage_invalid'));

  const wrongDepth = structuredClone(plan);
  wrongDepth.questions[0].depth = 'pressure';
  assert.ok((await validateProjectInterviewPack(root, input, wrongDepth)).errors.some((error) => error.code === 'question_depth_progression_invalid'));
});

test('模型选中的已验证 Fact 会形成项目专属题目锚点和准备重点', async () => {
  const root = createFixture({
    projectAlphaDetailStatement: '在项目甲中基于消息队列实现失败任务恢复与幂等重试',
  });
  const source = (await listProjectInterviewSources(root)).sources[0];
  const input = { source_id: source.id, project_id: 'project_alpha', target_role: 'AI 应用开发工程师' };
  const request = await buildProjectInterviewPackRequest(root, input);
  const summary = factRef(request.context, 'project.project_alpha.summary');
  const detail = factRef(request.context, 'project.project_alpha.detail');
  const plan = validPackPlan(request.context, 'project_alpha', 'project.project_alpha.summary');
  plan.target_role = input.target_role;
  plan.analysis_facts = [summary, detail];
  plan.questions[3].answer_facts = [detail];
  plan.questions[5].answer_facts = [detail];
  const result = await validateProjectInterviewPack(root, input, plan);

  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.match(result.pack.questions[3].question, /消息队列实现失败任务恢复与幂等重试/);
  assert.match(result.pack.questions[5].question, /消息队列实现失败任务恢复与幂等重试/);
  assert.ok(result.pack.analysis.interviewer_focus.some((item) => item.includes('project.project_alpha') || item.includes('消息队列')));
  assert.ok(result.pack.analysis.preparation_priorities.some((item) => item.includes('消息队列')));
  assert.doesNotMatch(result.pack.questions[3].question, /Celery|准确率|吞吐/);
});

test('模型计划连续失效时可生成稳定、只引用可信 Fact 的确定性训练包', async () => {
  const root = createFixture({
    projectAlphaDetailStatement: '在项目甲中基于消息队列实现失败任务恢复与幂等重试',
  });
  const source = (await listProjectInterviewSources(root)).sources[0];
  const input = { source_id: source.id, project_id: 'project_alpha', target_role: 'AI 应用开发工程师' };
  const first = await buildDeterministicProjectInterviewPack(root, input);
  const second = await buildDeterministicProjectInterviewPack(root, input);

  assert.deepEqual(first, second);
  assert.equal(first.questions.length, 6);
  assert.deepEqual(first.questions.map((item) => item.id), ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']);
  const trustedIds = new Set(source.projects.find((item) => item.id === 'project_alpha').fact_ids);
  const referencedIds = [
    ...first.analysis.source_fact_ids,
    ...first.opening_answer.source_fact_ids,
    ...first.questions.flatMap((item) => item.reference_answer.source_fact_ids),
  ];
  assert.ok(referencedIds.every((id) => trustedIds.has(id)));
  assert.ok(first.questions.some((item) => item.question.includes('消息队列实现失败任务恢复与幂等重试')));
});

test('回答点评 Schema 将项目、问答哈希和更强版本 Fact 锁定到本次可信上下文', async () => {
  const root = createFixture();
  const source = (await listProjectInterviewSources(root)).sources[0];
  const input = {
    source_id: source.id,
    project_id: 'project_alpha',
    target_role: 'AI 应用开发工程师',
    question: '这个项目如何恢复失败任务？',
    answer: '我会先说明当前 Fact 能证明的动作，并把未确认细节标为待核实。',
  };
  const request = await buildProjectInterviewReviewRequest(root, input);
  const schema = request.proposal_schema;
  assert.equal(schema.properties.project_id.const, 'project_alpha');
  assert.equal(schema.properties.question_sha256.const, request.context.question_sha256);
  assert.equal(schema.properties.answer_sha256.const, request.context.answer_sha256);
  assert.ok(schema.properties.stronger_fact_refs.items.enum.every((ref) => (
    ref.fact_id.startsWith('project.project_alpha.') && /^[a-f0-9]{64}$/.test(ref.fact_sha256)
  )));
});

test('训练包按哈希绑定并精确渲染已确认 ResumeVariant rewrite', async () => {
  const rewritten = '项目甲 个人项目 示例技术栈';
  const root = createFixture({
    rewrites: [{ fact_id: 'project.project_alpha.summary', proposed_statement: rewritten, accepted: true }],
  });
  const source = (await listProjectInterviewSources(root)).sources[0];
  const input = { source_id: source.id, project_id: 'project_alpha', target_role: 'Java 后端开发' };
  const request = await buildProjectInterviewPackRequest(root, input);
  const plan = validPackPlan(request.context, 'project_alpha', 'project.project_alpha.summary');
  const result = await validateProjectInterviewPack(root, input, plan);

  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.pack.analysis.positioning.includes(rewritten), true);
  assert.equal(result.pack.opening_answer.answer.includes(rewritten), true);
  assert.doesNotMatch(result.pack.opening_answer.answer, /项目甲｜个人项目｜示例技术栈/);
});

function validReviewPlan(context, projectId, question, answer, factId) {
  const quote = '吞吐提升 80%';
  return {
    schema_version: 1,
    phase: 'feedback_plan',
    project_id: projectId,
    question_sha256: sha256(Buffer.from(question, 'utf8')),
    answer_sha256: sha256(Buffer.from(answer, 'utf8')),
    dimension_scores: { structure: 12, ownership: 12, technical_depth: 12, evidence: 8, boundary: 12 },
    landed_spans: [{ dimension: 'structure', quote: '我做完以后', occurrence: 0 }],
    sharpen: [{ dimension: 'evidence', quote, occurrence: 0, repair_template: 'add_verified_evidence' }],
    unsupported_spans: [{ quote, occurrence: 0, reason: 'metric_not_in_facts' }],
    stronger_fact_refs: [factRef(context, factId)],
    follow_up_template: 'validation_evidence',
  };
}

test('模拟反馈必须标出回答中新出现的指标，且更强版本不得复用未核实主张', async () => {
  const root = createFixture();
  const source = (await listProjectInterviewSources(root)).sources[0];
  const input = {
    source_id: source.id,
    project_id: 'project_gamma',
    target_role: 'Java 后端开发',
    question: '请介绍这个项目中最关键的技术取舍。',
    answer: '我做完以后吞吐提升 80%，所以这个方案很有效。',
  };
  const request = await buildProjectInterviewReviewRequest(root, input);
  assert.match(request.prompt, /吞吐提升 80%/);
  assert.match(request.prompt, /原回答精确子串/);

  const plan = validReviewPlan(request.context, 'project_gamma', input.question, input.answer, 'project.project_gamma.summary');
  const result = await validateProjectInterviewReview(root, input, plan);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.review.question, input.question);
  assert.equal(result.review.score, 40);
  assert.ok(result.review.unsupported_claims.some((item) => item.claim.includes('80%')));
  assert.equal(result.review.stronger_version.answer.includes(request.context.project.facts[0].statement), true);
  assert.doesNotMatch(result.review.stronger_version.answer, /吞吐提升 80%|Celery|稳定上线/);

  const wrongQuote = structuredClone(plan);
  wrongQuote.landed_spans[0].quote = '原回答里不存在的句子';
  assert.ok((await validateProjectInterviewReview(root, input, wrongQuote)).errors.some((error) => error.code === 'answer_quote_mismatch'));

  const wrongAnswerHash = structuredClone(plan);
  wrongAnswerHash.answer_sha256 = 'f'.repeat(64);
  assert.ok((await validateProjectInterviewReview(root, input, wrongAnswerHash)).errors.some((error) => error.code === 'answer_hash_mismatch'));

  const wrongFactHash = structuredClone(plan);
  wrongFactHash.stronger_fact_refs[0].fact_sha256 = '0'.repeat(64);
  assert.ok((await validateProjectInterviewReview(root, input, wrongFactHash)).errors.some((error) => error.code === 'fact_hash_mismatch'));

  await assert.rejects(() => buildProjectInterviewReviewRequest(root, {
    ...input,
    answer: '我的回答里夹带联系邮箱 candidate@example.com',
  }), (error) => error?.code === 'INTERVIEW_INPUT_FORBIDDEN');

  await assert.rejects(() => buildProjectInterviewReviewRequest(root, {
    ...input,
    question: '请联系我：13800138000，再继续提问。',
  }), (error) => error?.code === 'INTERVIEW_INPUT_FORBIDDEN');

  await assert.rejects(() => buildProjectInterviewReviewRequest(root, {
    ...input,
    question: '我的家庭住址为北京市海淀区中关村大街27号，请据此提问。',
  }), (error) => error?.code === 'INTERVIEW_INPUT_FORBIDDEN');

  await assert.rejects(() => buildProjectInterviewPackRequest(root, {
    ...input,
    question: undefined,
    answer: undefined,
    target_role: 'Java 后端 candidate@example.com',
  }), (error) => error?.code === 'INTERVIEW_INPUT_FORBIDDEN');
});

test('模型点评连续失效时用零分安全反馈保留本地事实核验', async () => {
  const root = createFixture();
  const source = (await listProjectInterviewSources(root)).sources[0];
  const input = {
    source_id: source.id,
    project_id: 'project_gamma',
    target_role: 'Java 后端开发',
    question: '请说明你的责任边界和验证结果。',
    answer: '我独立完成全部架构，吞吐提升 80%。',
  };
  const review = await buildDeterministicProjectInterviewReview(root, input);

  assert.equal(review.status, 'gap');
  assert.equal(review.score, 0);
  assert.ok(review.unsupported_claims.some((item) => item.claim.includes('独立完成全部架构')));
  assert.ok(review.unsupported_claims.some((item) => item.claim.includes('吞吐提升 80%')));
  assert.doesNotMatch(review.stronger_version.answer, /独立完成全部架构|吞吐提升 80%/);
});

test('AI 不能把未获 Fact 支持的归属主张评为强答案', async () => {
  const root = createFixture();
  const source = (await listProjectInterviewSources(root)).sources[0];
  const input = {
    source_id: source.id,
    project_id: 'project_gamma',
    target_role: 'Java 后端开发',
    question: '请说明你的责任边界。',
    answer: 'I owned the entire core architecture',
  };
  const request = await buildProjectInterviewReviewRequest(root, input);
  const quote = input.answer;
  const plan = {
    schema_version: 1,
    phase: 'feedback_plan',
    project_id: 'project_gamma',
    question_sha256: request.context.question_sha256,
    answer_sha256: request.context.answer_sha256,
    dimension_scores: { structure: 20, ownership: 20, technical_depth: 20, evidence: 20, boundary: 20 },
    landed_spans: [{ dimension: 'ownership', quote, occurrence: 0 }],
    sharpen: [{ dimension: 'ownership', quote, occurrence: 0, repair_template: 'clarify_ownership' }],
    unsupported_spans: [],
    stronger_fact_refs: [factRef(request.context, 'project.project_gamma.summary')],
    follow_up_template: 'responsibility_boundary',
  };
  const result = await validateProjectInterviewReview(root, input, plan);

  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.review.status, 'gap');
  assert.ok(result.review.score < 60);
  assert.ok(result.review.unsupported_claims.some((item) => item.claim === quote));
  assert.match(result.review.landed[0], /没有可与.*待核实主张.*分离/);
});

test('已确认 Fact 的同义改写不会被误判为新增事实', async () => {
  const root = createFixture();
  const source = (await listProjectInterviewSources(root)).sources[0];
  const input = {
    source_id: source.id,
    project_id: 'project_alpha',
    target_role: 'AI 应用开发工程师',
    question: '请说明你在项目中的本人责任。',
    answer: '我在项目甲里实现了任务暂停功能',
  };
  const request = await buildProjectInterviewReviewRequest(root, input);
  const quote = input.answer;
  const plan = {
    schema_version: 1,
    phase: 'feedback_plan',
    project_id: 'project_alpha',
    question_sha256: request.context.question_sha256,
    answer_sha256: request.context.answer_sha256,
    dimension_scores: { structure: 20, ownership: 20, technical_depth: 20, evidence: 20, boundary: 20 },
    landed_spans: [{ dimension: 'ownership', quote, occurrence: 0 }],
    sharpen: [{ dimension: 'technical_depth', quote, occurrence: 0, repair_template: 'explain_mechanism' }],
    unsupported_spans: [],
    stronger_fact_refs: [factRef(request.context, 'project.project_alpha.detail')],
    follow_up_template: 'technical_mechanism',
  };
  const result = await validateProjectInterviewReview(root, input, plan);

  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.review.status, 'strong');
  assert.deepEqual(result.review.unsupported_claims, []);
  assert.match(result.review.stronger_version.answer, /在项目甲中实现任务暂停模块/);
});

test('careerpilot CLI 通过只读命令公开同一个项目目录', async () => {
  const root = createFixture();
  const cliPath = join(import.meta.dirname, 'careerpilot.mjs');
  const output = execFileSync(process.execPath, [
    cliPath, 'interview-projects', '--root', root,
  ], { encoding: 'utf8' });
  const catalog = JSON.parse(output);
  assert.deepEqual(catalog.sources[0].projects.map((project) => project.id), [
    'project_alpha', 'project_beta', 'project_gamma',
  ]);

  const input = { source_id: catalog.sources[0].id, project_id: 'project_gamma', target_role: 'Java 后端开发' };
  const request = await buildProjectInterviewPackRequest(root, input);
  const proposal = validPackPlan(request.context, 'project_gamma', 'project.project_gamma.summary');
  const validated = JSON.parse(execFileSync(process.execPath, [
    cliPath, 'interview-pack-validate', '--stdin', '--root', root,
  ], { encoding: 'utf8', input: JSON.stringify({ ...input, proposal }) }));
  assert.equal(validated.pack.questions.length, 6);
  assert.equal(validated.pack.opening_answer.source_fact_ids[0], 'project.project_gamma.summary');

  const fallbackPack = JSON.parse(execFileSync(process.execPath, [
    cliPath, 'interview-pack-fallback', '--stdin', '--root', root,
  ], { encoding: 'utf8', input: JSON.stringify(input) }));
  assert.equal(fallbackPack.generation_mode, 'deterministic_fallback');
  assert.equal(fallbackPack.pack.questions.length, 6);

  const reviewInput = {
    ...input,
    question: '请说明项目验证。',
    answer: '我让吞吐提升 80%。',
  };
  const fallbackReview = JSON.parse(execFileSync(process.execPath, [
    cliPath, 'interview-review-fallback', '--stdin', '--root', root,
  ], { encoding: 'utf8', input: JSON.stringify(reviewInput) }));
  assert.equal(fallbackReview.generation_mode, 'deterministic_fallback');
  assert.equal(fallbackReview.review.score, 0);
});
