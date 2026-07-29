#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  evaluateEligibility,
  evaluateJob,
  inferJobPosting,
  loadJobEvaluation,
  parseJobFile,
  saveJobEvaluation,
  validateFitProposal,
  validateJobPosting,
  validateMatchReport,
} from './lib/careerpilot/job-core.mjs';

function fact(id, type, statement) {
  return {
    id, type, statement, status: 'confirmed', sensitivity: 'personal',
    allowed_uses: ['resume', 'application_form', 'job_match'], evidence_ids: [`evidence.${id}`],
  };
}

function profileFixture() {
  const facts = [
    fact('education.degree', 'education', '本科学历'),
    fact('education.major', 'education', '计算机科学与技术专业'),
    fact('education.major_code', 'education', '专业代码 080901'),
    fact('education.cohort', 'education', '2027届毕业生'),
    fact('education.graduation', 'education', '预计 2027 年 6 月 30 日毕业'),
    fact('certificate.cet4', 'certificate', '大学英语四级 520 分'),
    fact('credential.software', 'certificate', '持有软件设计师资格证书'),
    fact('preference.location', 'preference', '意向工作地点为北京或上海'),
    fact('skill.java', 'skill', '掌握 Java 后端开发'),
  ];
  return {
    schema_version: 2,
    candidate: { display_name: '匿名候选人' },
    structured: {
      education: {
        degree: { value: 'bachelor', fact_id: 'education.degree' },
        major_name: { value: '计算机科学与技术', fact_id: 'education.major' },
        major_code: { value: '080901', fact_id: 'education.major_code' },
        cohort: { value: 2027, fact_id: 'education.cohort' },
        graduation_date: { value: '2027-06-30', fact_id: 'education.graduation' },
      },
      language_certificates: [{ kind: 'CET4', score: 520, fact_id: 'certificate.cet4' }],
      credentials: [{ name: '软件设计师资格证书', fact_id: 'credential.software' }],
      preferences: { locations: { value: ['北京', '上海'], fact_id: 'preference.location' } },
    },
    facts,
    evidence: facts.map((item) => ({
      id: `evidence.${item.id}`, kind: 'official_link', ref: `https://example.invalid/${item.id}`,
      strength: 'strong', verified_at: '2026-07-28T12:00:00.000Z',
    })),
  };
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-job-'));
  mkdirSync(join(root, 'profile'), { recursive: true });
  writeFileSync(join(root, 'profile', 'candidate.yml'), yaml.dump(profileFixture()), 'utf8');
  return root;
}

const jd = [
  '招聘单位：中国示例集团（中央企业）',
  '岗位名称：信息技术岗',
  '岗位代码：IT-2027-01',
  '面向2027届应届毕业生校园招聘',
  '学历要求：本科及以上',
  '专业要求：计算机科学与技术、软件工程',
  '英语要求：大学英语四级成绩达到425分',
  '工作地点：北京、上海',
  '报名截止：2027年06月30日',
].join('\n');

function fullDimensions(score = 4.2) {
  return [
    { id: 'role_major', score, candidate_fact_ids: ['education.major'], rationale: '专业与岗位一致' },
    { id: 'evidence', score, candidate_fact_ids: ['skill.java'], rationale: '已有事实证据' },
    { id: 'career_direction', score, candidate_fact_ids: [], rationale: '方向匹配' },
    { id: 'mobility', score, candidate_fact_ids: ['preference.location'], rationale: '地点匹配' },
    { id: 'development', score, candidate_fact_ids: [], rationale: '培养机制明确' },
    { id: 'source_reliability', score: 5, candidate_fact_ids: [], rationale: '来源待官网复核' },
  ];
}

test('央企校招文本可提取稳定岗位 ID、硬规则和截止时间', () => {
  const posting = inferJobPosting(jd, { kind: 'pasted_text' });
  assert.match(posting.id, /^job\.[a-f0-9]{24}$/);
  assert.equal(posting.employer.type, 'central_soe');
  assert.equal(posting.recruitment.track, 'campus');
  assert.equal(posting.recruitment.cohort, 2027);
  assert.equal(posting.recruitment.deadline, '2027-06-30');
  assert.ok(posting.rules.some((rule) => rule.field === 'degree'));
  assert.ok(posting.rules.some((rule) => rule.field === 'major_name'));
  assert.ok(posting.rules.some((rule) => rule.field === 'language_certificate'));
  assert.deepEqual(validateJobPosting(posting), { valid: true, errors: [] });
});

test('明确且有原文依据的学历、专业、届别和英语规则确定性通过', () => {
  const posting = inferJobPosting(jd);
  const eligibility = evaluateEligibility(profileFixture(), posting);
  assert.equal(eligibility.result, 'eligible');
  assert.ok(eligibility.rule_results.every((item) => item.result === 'satisfied'));
});

test('专业代码、毕业时间范围、资格证书和地点规则均由原文确定性计算', () => {
  const extended = [
    jd,
    '专业代码要求：080901、080902',
    '毕业时间要求：2026年09月01日至2027年07月31日',
    '证书要求：软件设计师资格证书',
  ].join('\n');
  const posting = inferJobPosting(extended);
  for (const field of ['major_code', 'graduation_date', 'credential', 'location']) {
    assert.ok(posting.rules.some((rule) => rule.field === field && rule.explicit && rule.source_quote), `missing explicit ${field} rule`);
  }
  assert.equal(evaluateEligibility(profileFixture(), posting).result, 'eligible');

  const locationMismatch = profileFixture();
  locationMismatch.structured.preferences.locations.value = ['深圳'];
  assert.equal(evaluateEligibility(locationMismatch, posting).result, 'ineligible');

  const missingCredential = profileFixture();
  missingCredential.structured.credentials = [];
  assert.equal(evaluateEligibility(missingCredential, posting).result, 'unknown');
});

test('明确截止日期过期会阻断申请建议，但不伪造候选人资格失败', () => {
  const expired = inferJobPosting(jd.replace('报名截止：2027年06月30日', '报名截止：2000年01月01日'));
  assert.equal(expired.posting_status, 'expired');
  assert.equal(evaluateEligibility(profileFixture(), expired).result, 'eligible');
  assert.equal(evaluateJob(fixtureRoot(), expired, { dimensions: fullDimensions() }).recommendation, 'do_not_apply');
});

test('明确硬规则不满足会失败，缺事实会返回 unknown', () => {
  const posting = inferJobPosting(jd);
  const mismatch = profileFixture();
  mismatch.structured.education.degree.value = 'associate';
  assert.equal(evaluateEligibility(mismatch, posting).result, 'ineligible');

  const missing = profileFixture();
  delete missing.structured.education.major_name;
  assert.equal(evaluateEligibility(missing, posting).result, 'unknown');
});

test('没有招聘原文引用的推测规则不能造成自动淘汰', () => {
  const posting = inferJobPosting(jd);
  posting.rules.push({
    id: 'rule.credential.inferred', field: 'credential', operator: 'one_of', expected: ['计算机等级证书'],
    severity: 'hard', explicit: false, source_quote: '', confidence: 0.4,
  });
  const eligibility = evaluateEligibility(profileFixture(), posting);
  assert.equal(eligibility.result, 'unknown');
  assert.equal(eligibility.rule_results.at(-1).result, 'unknown');
});

test('AI 软匹配建议必须通过 JSON Schema 且只能引用允许的候选人事实', () => {
  const root = fixtureRoot();
  const valid = validateFitProposal(root, {
    dimensions: fullDimensions(), strengths: ['专业方向匹配'], gaps: ['补充岗位动机'],
  });
  assert.equal(valid.dimensions.length, 6);
  assert.throws(() => validateFitProposal(root, {
    dimensions: fullDimensions().slice(0, 5), strengths: [], gaps: [],
  }), (error) => error.code === 'FIT_PROPOSAL_INVALID');
  const unknownFact = fullDimensions();
  unknownFact[0].candidate_fact_ids = ['restricted.identity'];
  assert.throws(() => validateFitProposal(root, {
    dimensions: unknownFact, strengths: [], gaps: [],
  }), (error) => error.code === 'FIT_PROPOSAL_INVALID' && error.details.some((item) => item.code === 'fit_fact_not_allowed'));
});

test('软匹配权重由核心固定，粘贴文本来源可靠性最高只能为 3 分', () => {
  const root = fixtureRoot();
  const posting = inferJobPosting(jd);
  const report = evaluateJob(root, posting, { dimensions: fullDimensions(5) });
  assert.equal(report.fit.dimensions.find((item) => item.id === 'source_reliability').score, 3);
  assert.equal(report.fit.score, 4.9);
  assert.equal(report.recommendation, 'apply');
  assert.deepEqual(validateMatchReport(report), { valid: true, errors: [] });
});

test('资格失败只能通过带原因的人工覆盖降级为谨慎考虑', () => {
  const root = fixtureRoot();
  const profile = profileFixture();
  profile.structured.education.degree.value = 'associate';
  writeFileSync(join(root, 'profile', 'candidate.yml'), yaml.dump(profile), 'utf8');
  const posting = inferJobPosting(jd);
  assert.equal(evaluateJob(root, posting, { dimensions: fullDimensions() }).recommendation, 'do_not_apply');
  const overridden = evaluateJob(root, posting, { dimensions: fullDimensions(), override_reason: '招聘公告允许相近专业人工复核' });
  assert.equal(overridden.recommendation, 'consider');
  assert.match(overridden.override.reason, /人工复核/);
});

test('岗位、匹配和人类可读报告以同一哈希原子保存并可重新加载', () => {
  const root = fixtureRoot();
  const posting = inferJobPosting(jd);
  const report = evaluateJob(root, posting, { dimensions: fullDimensions(), strengths: ['专业匹配'], gaps: ['补充岗位动机'] });
  const paths = saveJobEvaluation(root, posting, report);
  assert.ok(existsSync(paths.job_path));
  assert.ok(existsSync(paths.match_path));
  assert.ok(existsSync(paths.report_path));
  assert.deepEqual(loadJobEvaluation(root, posting.id), { posting, report });
  assert.match(readFileSync(paths.report_path, 'utf8'), /资格结论：符合/);
});

test('输出会清理疑似身份证号码，不把受限值写入报告', () => {
  const root = fixtureRoot();
  const posting = inferJobPosting(jd);
  const report = evaluateJob(root, posting, { dimensions: fullDimensions(), gaps: ['身份证号 11010120000101001X 需要提交'] });
  const paths = saveJobEvaluation(root, posting, report);
  assert.doesNotMatch(JSON.stringify(report), /11010120000101001X/);
  assert.doesNotMatch(readFileSync(paths.report_path, 'utf8'), /11010120000101001X/);
  assert.match(report.gaps[0], /需本人手工填写/);
});

test('央企、地方国企、银行和运营商招聘公告均使用中国单位分类', () => {
  const samples = [
    ['某中央企业校园招聘\n岗位名称：信息岗', 'central_soe'],
    ['某省属国企校园招聘\n岗位名称：信息岗', 'local_soe'],
    ['某商业银行校园招聘\n岗位名称：科技岗', 'bank'],
    ['中国移动校园招聘\n岗位名称：网络岗', 'telecom'],
  ];
  for (const [text, type] of samples) assert.equal(inferJobPosting(text).employer.type, type);
});

test('文件导入拒绝不支持扩展名和伪造 PDF；图片 OCR 不会被误判为成功', async () => {
  const root = fixtureRoot();
  const txt = join(root, 'job.txt');
  const pdf = join(root, 'job.pdf');
  writeFileSync(txt, jd, 'utf8');
  writeFileSync(pdf, 'not-a-pdf', 'utf8');
  await assert.rejects(() => parseJobFile(txt), /Only PDF and DOCX/);
  await assert.rejects(() => parseJobFile(pdf), /signature is invalid/);
});
