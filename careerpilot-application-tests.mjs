#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { confirmJobPosting, evaluateJob, inferJobPosting, saveJobEvaluation } from './lib/careerpilot/job-core.mjs';
import { confirmResumeVariant, createResumeVariant } from './lib/careerpilot/resume-core.mjs';
import { createTailoringPreview, exportCampaignTailoredResume } from './lib/careerpilot/tailoring-core.mjs';
import { createCampaign, importCampaignSources, rankCampaign, selectCampaignJobs } from './lib/careerpilot/campaign-core.mjs';
import { loadTrustedResumeArtifact } from './lib/careerpilot/artifact-core.mjs';
import {
  CN_STAGE_TO_CANONICAL,
  loadApplication,
  prepareApplication,
  reconcileApplication,
  updateApplicationStage,
  updateApplicationFields,
  validateApplication,
} from './lib/careerpilot/application-core.mjs';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-application-'));
  mkdirSync(join(root, 'profile'), { recursive: true });
  const facts = [
    { id: 'education.degree', type: 'education', statement: '本科学历', value: 'bachelor' },
    { id: 'education.institution', type: 'education', statement: '匿名大学', value: '匿名大学' },
    { id: 'education.major', type: 'education', statement: '计算机科学与技术', value: '计算机科学与技术' },
    { id: 'education.cohort', type: 'education', statement: '2027届毕业生', value: 2027 },
    { id: 'certificate.cet4', type: 'certificate', statement: '大学英语四级 520 分' },
    { id: 'project.campus', type: 'project', statement: '完成匿名校园系统开发' },
    { id: 'preference.location', type: 'preference', statement: '意向北京' },
  ].map(({ value: _value, ...item }) => ({
    ...item, status: 'confirmed', sensitivity: 'personal',
    allowed_uses: ['resume', 'application_form', 'job_match'], evidence_ids: [`evidence.${item.id}`],
  }));
  const profile = {
    schema_version: 2,
    candidate: { display_name: '匿名候选人' },
    structured: {
      education: {
        degree: { value: 'bachelor', fact_id: 'education.degree' },
        institution: { value: '匿名大学', fact_id: 'education.institution' },
        major_name: { value: '计算机科学与技术', fact_id: 'education.major' },
        cohort: { value: 2027, fact_id: 'education.cohort' },
      },
      language_certificates: [{ kind: 'CET4', score: 520, fact_id: 'certificate.cet4' }],
      credentials: [],
      preferences: { locations: { value: ['北京'], fact_id: 'preference.location' } },
    },
    facts,
    evidence: facts.map((item) => ({
      id: `evidence.${item.id}`, kind: 'official_link', ref: `https://example.invalid/${item.id}`,
      strength: 'strong', verified_at: '2026-07-28T12:00:00.000Z',
    })),
  };
  writeFileSync(join(root, 'profile', 'candidate.yml'), yaml.dump(profile), 'utf8');
  const pendingPosting = inferJobPosting([
    '招聘单位：某商业银行', '岗位名称：信息科技岗', '岗位代码：BANK-2027-01',
    '面向2027届应届毕业生', '学历要求：本科及以上', '专业要求：计算机科学与技术',
    '报名截止：2027年05月31日',
  ].join('\n'));
  pendingPosting.rules = pendingPosting.rules.map((rule) => ({ ...rule, confirmation_status: 'confirmed' }));
  const posting = confirmJobPosting(pendingPosting);
  const report = evaluateJob(root, posting);
  saveJobEvaluation(root, posting, report);
  return { root, posting, report };
}

async function setupCampaignApplication() {
  const result = setup();
  await prepareApplication(result.root, result.posting.id);
  const campaign = createCampaign(result.root, {
    name: '匿名银行校招对比', employer: result.posting.employer.name, max_applications: 1,
    constraint_confirmation_status: 'confirmed', constraint_source_quote: '最多投递一个岗位',
  });
  await importCampaignSources(result.root, campaign.id, [{ kind: 'text', text: result.posting.raw_text }]);
  rankCampaign(result.root, campaign.id);
  selectCampaignJobs(result.root, campaign.id, [result.posting.id], { reason: '匿名验收首选' });
  const baseline = confirmResumeVariant(result.root, createResumeVariant(result.root, { template: 'soe-one-page' })).variant;
  const preview = createTailoringPreview(result.root, result.posting.id, { baseline_variant: baseline });
  const artifact = await exportCampaignTailoredResume(
    result.root, campaign.id, preview, 'pdf', 'output/careerpilot/final/application-resume.pdf',
  );
  return { ...result, campaign: campaign.id, manifest: `${artifact.path}.manifest.json` };
}

test('网申准备通过 TSV 合并创建兼容 tracker 行和中国申请侧车', async () => {
  const { root, posting } = setup();
  const { application, path } = await prepareApplication(root, posting.id);
  assert.ok(existsSync(path));
  assert.equal(application.current_stage, 'evaluated');
  assert.equal(application.canonical_status, 'Evaluated');
  assert.equal(application.deadline, '2027-05-31');
  const tracker = readFileSync(join(root, 'data', 'applications.md'), 'utf8');
  assert.match(tracker, new RegExp(`job:${posting.id.replaceAll('.', '\\.')}`));
  assert.match(tracker, /\| Evaluated \|/);
  assert.deepEqual(reconcileApplication(root, application.tracker_num), {
    consistent: true, tracker_status: 'Evaluated', sidecar_status: 'Evaluated', stage: 'evaluated',
  });
});

test('Campaign 网申准备必须绑定当前可信最终简历 artifact', async () => {
  const { root, posting, campaign, manifest } = await setupCampaignApplication();
  await assert.rejects(
    () => prepareApplication(root, posting.id, { campaign_id: campaign }),
    (error) => error.code === 'CAMPAIGN_RESUME_REQUIRED',
  );
  const { application } = await prepareApplication(root, posting.id, {
    campaign_id: campaign,
    resume_manifest: manifest,
  });
  assert.equal(application.campaign_id, campaign);
  assert.equal(application.resume_artifact.manifest, 'output/careerpilot/final/application-resume.pdf.manifest.json');
  assert.match(application.resume_artifact.content_sha256, /^[a-f0-9]{64}$/);
  assert.ok(application.pre_submission_checklist.some((item) => item.id === 'final_resume' && item.status === 'ready'));
  assert.ok(application.pre_submission_checklist.some((item) => item.id === 'external_submit' && item.status === 'manual_required'));
  assert.equal('submit' in application, false);
});

test('an old final resume stays stale after the same job is selected again', async () => {
  const { root, posting, campaign, manifest } = await setupCampaignApplication();
  const profilePath = join(root, 'profile', 'candidate.yml');
  writeFileSync(profilePath, `${readFileSync(profilePath, 'utf8')}\n# source changed\n`, 'utf8');
  saveJobEvaluation(root, posting, evaluateJob(root, posting));
  rankCampaign(root, campaign);
  selectCampaignJobs(root, campaign, [posting.id], { reason: 'Re-evaluated and explicitly selected again.' });
  assert.throws(
    () => loadTrustedResumeArtifact(root, manifest, { campaign_id: campaign, job_id: posting.id }),
    (error) => error.code === 'RESUME_ARTIFACT_STALE' || error.code === 'RESUME_VARIANT_INVALID',
  );
});

test('网申准备接收岗位表单字段和特有材料，并生成事实引用与待确认草稿', async () => {
  const { root, posting } = setup();
  const { application } = await prepareApplication(root, posting.id, {
    form_fields: [{
      id: 'motivation.why_bank', label: '为什么选择本行', category: 'motivation', required: true,
      max_length: 180, source_quote: '请结合个人经历说明为什么选择本行',
    }],
    materials: [{ id: 'employment_recommendation', label: '就业推荐表', required: true, source_quote: '请上传就业推荐表' }],
  });
  const custom = application.fields.find((item) => item.id === 'motivation.why_bank');
  assert.equal(custom.definition_source, 'application_form');
  assert.equal(custom.max_length, 180);
  assert.equal(custom.confirmation_status, 'pending');
  assert.ok(custom.source_fact_ids.length > 0);
  assert.match(custom.draft, /信息科技岗|校园系统/);
  assert.deepEqual(application.materials.find((item) => item.id === 'employment_recommendation'), {
    id: 'employment_recommendation', label: '就业推荐表', required: true, status: 'missing', evidence_ids: [],
    manual_required: false, definition_source: 'job_posting', source_quote: '请上传就业推荐表',
  });
  assert.equal('submit' in application, false);
});

test('已有申请侧车可在共享锁下刷新岗位特有字段和材料定义', async () => {
  const { root, posting } = setup();
  const first = await prepareApplication(root, posting.id);
  const refreshed = await prepareApplication(root, posting.id, {
    form_fields: [{
      id: 'motivation.why_company', label: '为什么选择本单位', category: 'motivation', required: true,
      max_length: 160, source_quote: '请说明为什么选择本单位',
    }],
    materials: [{ id: 'recommendation_form', label: '就业推荐表', required: true, source_quote: '请上传就业推荐表' }],
  });
  assert.equal(refreshed.application.tracker_num, first.application.tracker_num);
  assert.equal(refreshed.application.fields.find((item) => item.id === 'motivation.why_company').definition_source, 'application_form');
  assert.equal(refreshed.application.materials.find((item) => item.id === 'recommendation_form').definition_source, 'job_posting');
  assert.equal(reconcileApplication(root, first.application.tracker_num).consistent, true);
});

test('身份证、家庭成员和详细住址始终只给手工填写提示，不保存值或证据引用', async () => {
  const { root, posting } = setup();
  const { application, path } = await prepareApplication(root, posting.id);
  for (const id of ['personal.identity_number', 'personal.family_members', 'personal.full_address']) {
    const item = application.fields.find((field) => field.id === id);
    assert.equal(item.sensitivity, 'restricted');
    assert.equal(item.manual_required, true);
    assert.deepEqual(item.source_fact_ids, []);
    assert.equal('draft' in item, false);
  }
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(stored.fields.filter((item) => item.sensitivity === 'restricted').every((item) => !('draft' in item)));
  assert.equal(application.materials.find((item) => item.id === 'identity_document').status, 'manual_required');
});

test('受限字段值和超过字数上限的回答会被确定性校验拒绝', async () => {
  const { root, posting } = setup();
  const { application } = await prepareApplication(root, posting.id);
  const restricted = structuredClone(application);
  restricted.fields.find((item) => item.id === 'personal.identity_number').draft = '11010120000101001X';
  assert.ok(validateApplication(restricted).errors.some((item) => item.code === 'restricted_value_persisted'));
  const tooLong = structuredClone(application);
  tooLong.fields.find((item) => item.id === 'motivation.application').draft = '动'.repeat(501);
  assert.ok(validateApplication(tooLong).errors.some((item) => item.code === 'field_length_exceeded'));
});

test('网申回答只更新允许字段，受限字段没有任何写入接口', async () => {
  const { root, posting } = setup();
  const { application } = await prepareApplication(root, posting.id);
  const updated = await updateApplicationFields(root, application.tracker_num, { 'motivation.application': '希望在信息科技岗位稳步成长' });
  assert.equal(updated.fields.find((item) => item.id === 'motivation.application').draft, '希望在信息科技岗位稳步成长');
  assert.equal(updated.fields.find((item) => item.id === 'motivation.application').confirmation_status, 'confirmed');
  await assert.rejects(
    () => updateApplicationFields(root, application.tracker_num, { 'personal.identity_number': '11010120000101001X' }),
    (error) => error.code === 'RESTRICTED_FIELD',
  );
  assert.doesNotMatch(readFileSync(join(root, 'data', 'careerpilot', 'applications', `${application.tracker_num}.json`), 'utf8'), /11010120000101001X/);
});

test('中国详细阶段通过 set-status 锁定路径同步到九种兼容状态', async () => {
  const { root, posting } = setup();
  const { application } = await prepareApplication(root, posting.id);
  const stages = [
    ['submitted', 'Applied'],
    ['qualification', 'Responded'],
    ['written_test_completed', 'Responded'],
    ['interview_professional', 'Interview'],
    ['medical', 'Interview'],
    ['intended_offer', 'Offer'],
    ['signed', 'Hired'],
  ];
  for (const [stage, canonical] of stages) {
    const result = await updateApplicationStage(root, application.tracker_num, stage, { note: `测试阶段 ${stage}`, external_submission_confirmed: stage === 'submitted' });
    assert.equal(result.application.canonical_status, canonical);
    assert.equal(result.reconciliation.consistent, true);
  }
  assert.equal(loadApplication(root, application.tracker_num).events.length, stages.length + 1);
});

test('进入已网申阶段必须明确确认已经在外部官网完成提交', async () => {
  const { root, posting } = setup();
  const { application } = await prepareApplication(root, posting.id);
  await assert.rejects(
    () => updateApplicationStage(root, application.tracker_num, 'submitted'),
    (error) => error.code === 'EXTERNAL_SUBMISSION_CONFIRMATION_REQUIRED',
  );
  assert.equal(loadApplication(root, application.tracker_num).current_stage, 'evaluated');
});

test('所有详细阶段都有固定兼容状态，不允许 Web 自行发明映射', () => {
  assert.deepEqual(CN_STAGE_TO_CANONICAL, {
    evaluated: 'Evaluated', pending_apply: 'Evaluated', submitted: 'Applied', qualification: 'Responded',
    assessment_notice: 'Responded', written_test_notice: 'Responded', written_test_completed: 'Responded',
    interview_first: 'Interview', interview_professional: 'Interview', interview_hr: 'Interview', medical: 'Interview',
    background_review: 'Interview', political_review: 'Interview', intended_offer: 'Offer', signed: 'Hired',
    ineligible: 'SKIP', withdrawn: 'Discarded', closed: 'Discarded', expired: 'Discarded', rejected: 'Rejected',
  });
});

test('详细阶段与 tracker 不一致时只报告冲突，不静默覆盖', async () => {
  const { root, posting } = setup();
  const { application } = await prepareApplication(root, posting.id);
  const trackerPath = join(root, 'data', 'applications.md');
  const content = readFileSync(trackerPath, 'utf8').replace('| Evaluated |', '| Rejected |');
  writeFileSync(trackerPath, content, 'utf8');
  assert.deepEqual(reconcileApplication(root, application.tracker_num), {
    consistent: false, tracker_status: 'Rejected', sidecar_status: 'Evaluated', stage: 'evaluated',
  });
  await assert.rejects(
    () => updateApplicationStage(root, application.tracker_num, 'submitted', { external_submission_confirmed: true }),
    (error) => error.code === 'APPLICATION_STATUS_CONFLICT'
      && error.details.tracker_status === 'Rejected'
      && error.details.sidecar_status === 'Evaluated',
  );
  assert.equal(loadApplication(root, application.tracker_num).current_stage, 'evaluated');
  assert.match(readFileSync(trackerPath, 'utf8'), /\| Rejected \|/);
});

test('详细阶段复用规范报告身份保护，错链时拒绝同时修改 tracker 和侧车', async () => {
  const { root, posting } = setup();
  const { application } = await prepareApplication(root, posting.id);
  const trackerPath = join(root, 'data', 'applications.md');
  const original = readFileSync(trackerPath, 'utf8');
  const mismatched = original.replace(/\[0*\d+\]\(([^)]*)\)/, '[999]($1)');
  assert.notEqual(mismatched, original);
  writeFileSync(trackerPath, mismatched, 'utf8');
  await assert.rejects(
    () => updateApplicationStage(root, application.tracker_num, 'submitted', { external_submission_confirmed: true }),
    (error) => error.code === 'TRACKER_REPORT_MISMATCH' && error.details.trackerNum === application.tracker_num,
  );
  assert.equal(loadApplication(root, application.tracker_num).current_stage, 'evaluated');
  assert.equal(readFileSync(trackerPath, 'utf8'), mismatched);
});

test('同一申请的并发阶段更新在共享锁内串行化且不丢事件', async () => {
  const { root, posting } = setup();
  const { application } = await prepareApplication(root, posting.id);
  await Promise.all([
    updateApplicationStage(root, application.tracker_num, 'submitted', { note: '并发更新 A', external_submission_confirmed: true }),
    updateApplicationStage(root, application.tracker_num, 'qualification', { note: '并发更新 B' }),
  ]);
  const stored = loadApplication(root, application.tracker_num);
  assert.equal(stored.events.length, 3);
  assert.deepEqual(new Set(stored.events.slice(1).map((event) => event.note)), new Set(['并发更新 A', '并发更新 B']));
  assert.equal(reconcileApplication(root, application.tracker_num).consistent, true);
});
