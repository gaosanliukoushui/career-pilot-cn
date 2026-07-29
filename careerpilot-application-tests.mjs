#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { evaluateJob, inferJobPosting, saveJobEvaluation } from './lib/careerpilot/job-core.mjs';
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
  const posting = inferJobPosting([
    '招聘单位：某商业银行', '岗位名称：信息科技岗', '岗位代码：BANK-2027-01',
    '面向2027届应届毕业生', '学历要求：本科及以上', '专业要求：计算机科学与技术',
    '报名截止：2027年05月31日',
  ].join('\n'));
  const report = evaluateJob(root, posting);
  saveJobEvaluation(root, posting, report);
  return { root, posting, report };
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
  const updated = updateApplicationFields(root, application.tracker_num, { 'motivation.application': '希望在信息科技岗位稳步成长' });
  assert.equal(updated.fields.find((item) => item.id === 'motivation.application').draft, '希望在信息科技岗位稳步成长');
  assert.throws(
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
    const result = updateApplicationStage(root, application.tracker_num, stage, { note: `测试阶段 ${stage}` });
    assert.equal(result.application.canonical_status, canonical);
    assert.equal(result.reconciliation.consistent, true);
  }
  assert.equal(loadApplication(root, application.tracker_num).events.length, stages.length + 1);
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
});
