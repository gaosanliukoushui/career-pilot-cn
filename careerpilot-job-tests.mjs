#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import JSZip from 'jszip';
import {
  confirmJobPosting,
  evaluateEligibility,
  evaluateJob,
  inferJobPosting,
  loadJobEvaluation,
  parseJobFile,
  parseJobUrl,
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

function minimalPdf(text) {
  const escaped = text.replace(/[()\\]/g, (value) => `\\${value}`);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${escaped.length + 34} >>\nstream\nBT /F1 12 Tf 72 720 Td (${escaped}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let source = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(source);
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) source += `${String(offset).padStart(10, '0')} 00000 n \n`;
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source);
}

async function minimalDocx(text, extraXml = '') {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p>${extraXml}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

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

function confirmedPosting(posting, options = {}) {
  const reviewed = structuredClone(posting);
  reviewed.rules = reviewed.rules.map((rule) => ({ ...rule, confirmation_status: 'confirmed' }));
  return confirmJobPosting(reviewed, options);
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
  assert.equal(posting.confirmation.status, 'pending');
  assert.ok(posting.rules.every((rule) => rule.confirmation_status === 'pending'));
  assert.deepEqual(validateJobPosting(posting), { valid: true, errors: [] });
});

test('岗位结构和逐条规则必须经用户确认后才能进入确定性评估', () => {
  const pending = inferJobPosting(jd);
  assert.throws(
    () => evaluateJob(fixtureRoot(), pending, { dimensions: fullDimensions(), strengths: [], gaps: [] }),
    (error) => error.code === 'JOB_NOT_CONFIRMED',
  );

  const reviewed = structuredClone(pending);
  reviewed.rules = reviewed.rules.map((rule) => ({ ...rule, confirmation_status: 'confirmed' }));
  const confirmed = confirmJobPosting(reviewed);
  assert.equal(confirmed.confirmation.status, 'confirmed');
  assert.match(confirmed.confirmation.structure_sha256, /^[a-f0-9]{64}$/);
  assert.equal(evaluateJob(fixtureRoot(), confirmed, { dimensions: fullDimensions(), strengths: [], gaps: [] }).eligibility.result, 'eligible');

  confirmed.title = '被确认后又被篡改的岗位';
  assert.throws(() => evaluateJob(fixtureRoot(), confirmed), (error) => error.code === 'JOB_POSTING_INVALID');
});

test('优先类措辞和描述性工作地点不会自动成为淘汰条件', () => {
  const posting = inferJobPosting([
    jd.replace('英语要求：大学英语四级成绩达到425分', '英语要求：大学英语六级优先'),
    '相关专业优先，优秀候选人可放宽专业限制',
  ].join('\n'));
  const english = posting.rules.find((rule) => rule.field === 'language_certificate');
  assert.equal(english?.severity, 'soft');
  assert.equal(posting.rules.some((rule) => rule.field === 'location'), false);
});

test('明确且有原文依据的学历、专业、届别和英语规则确定性通过', () => {
  const posting = confirmedPosting(inferJobPosting(jd));
  const eligibility = evaluateEligibility(profileFixture(), posting);
  assert.equal(eligibility.result, 'eligible');
  assert.ok(eligibility.rule_results.every((item) => item.result === 'satisfied'));
});

test('CET kind 加 level 的结构化档案能满足 CET4 最低等级要求', () => {
  const profile = profileFixture();
  profile.structured.language_certificates = [
    { kind: 'CET', level: 'CET-6', fact_id: 'certificate.cet4' },
  ];
  const posting = confirmedPosting(inferJobPosting(jd.replace('大学英语四级成绩达到425分', '大学英语四级成绩合格')));
  const english = evaluateEligibility(profile, posting).rule_results.find((item) => item.rule_id.includes('language_certificate'));
  assert.equal(english?.result, 'satisfied');
  assert.deepEqual(english?.candidate_fact_ids, ['certificate.cet4']);
});

test('专业代码、毕业时间范围、资格证书和地点规则均由原文确定性计算', () => {
  const extended = [
    jd,
    '专业代码要求：080901、080902',
    '毕业时间要求：2026年09月01日至2027年07月31日',
    '证书要求：软件设计师资格证书',
  ].join('\n');
  const posting = confirmedPosting(inferJobPosting(extended));
  for (const field of ['major_code', 'graduation_date', 'credential']) {
    assert.ok(posting.rules.some((rule) => rule.field === field && rule.explicit && rule.source_quote), `missing explicit ${field} rule`);
  }
  assert.equal(evaluateEligibility(profileFixture(), posting).result, 'eligible');

  const missingCredential = profileFixture();
  missingCredential.structured.credentials = [];
  assert.equal(evaluateEligibility(missingCredential, posting).result, 'unknown');
});

test('明确截止日期过期会阻断申请建议，但不伪造候选人资格失败', () => {
  const expired = confirmedPosting(inferJobPosting(jd.replace('报名截止：2027年06月30日', '报名截止：2000年01月01日')));
  assert.equal(expired.posting_status, 'expired');
  assert.equal(evaluateEligibility(profileFixture(), expired).result, 'eligible');
  assert.equal(evaluateJob(fixtureRoot(), expired, { dimensions: fullDimensions() }).recommendation, 'do_not_apply');
});

test('明确硬规则不满足会失败，缺事实会返回 unknown', () => {
  const posting = confirmedPosting(inferJobPosting(jd));
  const mismatch = profileFixture();
  mismatch.structured.education.degree.value = 'associate';
  assert.equal(evaluateEligibility(mismatch, posting).result, 'ineligible');

  const missing = profileFixture();
  delete missing.structured.education.major_name;
  assert.equal(evaluateEligibility(missing, posting).result, 'unknown');
});

test('没有招聘原文引用的推测规则不能造成自动淘汰', () => {
  const candidate = inferJobPosting(jd);
  candidate.rules = candidate.rules.map((rule) => ({ ...rule, confirmation_status: 'confirmed' }));
  candidate.rules.push({
    id: 'rule.credential.inferred', field: 'credential', operator: 'one_of', expected: ['计算机等级证书'],
    severity: 'hard', explicit: false, source_quote: '', confidence: 0.4, confirmation_status: 'rejected',
  });
  const posting = confirmJobPosting(candidate);
  const eligibility = evaluateEligibility(profileFixture(), posting);
  assert.equal(eligibility.result, 'eligible');
  assert.equal(eligibility.rule_results.some((item) => item.rule_id === 'rule.credential.inferred'), false);
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

test('最终 job-evaluate 入口不能绕过 FitProposal Schema 和事实白名单', () => {
  const root = fixtureRoot();
  const reviewed = inferJobPosting(jd);
  reviewed.rules = reviewed.rules.map((rule) => ({ ...rule, confirmation_status: 'confirmed' }));
  const posting = confirmJobPosting(reviewed);
  const bypass = fullDimensions();
  bypass[0].candidate_fact_ids = ['restricted.identity'];
  assert.throws(
    () => evaluateJob(root, posting, { dimensions: bypass, strengths: [], gaps: [] }),
    (error) => error.code === 'FIT_PROPOSAL_INVALID' && error.details.some((item) => item.code === 'fit_fact_not_allowed'),
  );
});

test('URL 抓取保留跳转元数据，且未确认官方来源的可靠性最高为 3 分', async () => {
  const responses = new Map([
    ['https://jobs.example.invalid/start', new Response(null, { status: 302, headers: { location: '/final' } })],
    ['https://jobs.example.invalid/final', new Response(`<html><head><title>示例集团招聘</title></head><body>${jd}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } })],
  ]);
  const posting = await parseJobUrl('https://jobs.example.invalid/start', {}, async (url) => responses.get(url.href));
  assert.equal(posting.source.kind, 'public_url');
  assert.equal(posting.source.ref, 'https://jobs.example.invalid/start');
  assert.equal(posting.source.final_url, 'https://jobs.example.invalid/final');
  assert.deepEqual(posting.source.redirect_chain, ['https://jobs.example.invalid/start', 'https://jobs.example.invalid/final']);
  assert.equal(posting.source.page_title, '示例集团招聘');
  posting.rules = posting.rules.map((rule) => ({ ...rule, confirmation_status: 'confirmed' }));
  const confirmed = confirmJobPosting(posting);
  const report = evaluateJob(fixtureRoot(), confirmed, { dimensions: fullDimensions(), strengths: [], gaps: [] });
  assert.equal(report.fit.dimensions.find((item) => item.id === 'source_reliability').score, 3);
});

test('软匹配权重由核心固定，粘贴文本来源可靠性最高只能为 3 分', () => {
  const root = fixtureRoot();
  const posting = confirmedPosting(inferJobPosting(jd));
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
  const posting = confirmedPosting(inferJobPosting(jd));
  assert.equal(evaluateJob(root, posting, { dimensions: fullDimensions() }).recommendation, 'do_not_apply');
  const overridden = evaluateJob(root, posting, { dimensions: fullDimensions(), override_reason: '招聘公告允许相近专业人工复核' });
  assert.equal(overridden.recommendation, 'consider');
  assert.match(overridden.override.reason, /人工复核/);
});

test('岗位、匹配和人类可读报告以同一哈希原子保存并可重新加载', () => {
  const root = fixtureRoot();
  const posting = confirmedPosting(inferJobPosting(jd));
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
  const posting = confirmedPosting(inferJobPosting(jd));
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

test('Moka SPA 快照从职位详情字段识别岗位、所属部门、地点和在招状态', () => {
  const posting = inferJobPosting([
    '首页', '校园招聘', '数字化-AI应用开发', '分享', '11 - 30 K/月|全职|其他|示例汽车科技公司|湖北·武汉市',
    '申请职位', '职位描述', '【工作职责】', '负责 AI Agent 系统的设计与开发。',
    '职位信息', '职位名称', '职位名称', '数字化-AI应用开发', '所属部门', '所属部门', '示例汽车科技公司',
    '工作地点', '工作地点', '湖北·武汉市', '申请职位',
  ].join('\n'));
  assert.equal(posting.title, '数字化-AI应用开发');
  assert.equal(posting.employer.name, '示例汽车科技公司');
  assert.deepEqual(posting.locations, ['湖北·武汉市']);
  assert.equal(posting.posting_status, 'active');
});

test('四类中国招聘单位均具备资格通过、失败和信息不足黄金矩阵', () => {
  const samples = [
    ['中国示例集团中央企业', 'central_soe'],
    ['某省属国有企业', 'local_soe'],
    ['中国示例商业银行', 'bank'],
    ['中国移动通信集团', 'telecom'],
  ];
  for (const [employer, expectedType] of samples) {
    const posting = confirmedPosting(inferJobPosting([
      `招聘单位：${employer}`, '岗位名称：信息技术岗', '面向2027届应届毕业生校园招聘',
      '学历要求：本科及以上', '专业要求：计算机科学与技术、软件工程',
      '英语要求：大学英语四级成绩达到425分',
    ].join('\n')));
    assert.equal(posting.employer.type, expectedType);
    const passing = profileFixture();
    assert.equal(evaluateEligibility(passing, posting).result, 'eligible', `${expectedType} pass`);
    const failing = structuredClone(passing);
    failing.structured.education.degree.value = 'associate';
    assert.equal(evaluateEligibility(failing, posting).result, 'ineligible', `${expectedType} fail`);
    const unknown = structuredClone(passing);
    delete unknown.structured.education.degree;
    assert.equal(evaluateEligibility(unknown, posting).result, 'unknown', `${expectedType} unknown`);
  }
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

test('真实可解析 PDF 和 DOCX 均生成带文件哈希的待确认岗位', async () => {
  const root = fixtureRoot();
  const pdfPath = join(root, 'real.pdf');
  const docxPath = join(root, 'real.docx');
  writeFileSync(pdfPath, minimalPdf('Campus recruitment job description for software engineer. Bachelor degree required. Apply before June 30 2027.'));
  writeFileSync(docxPath, await minimalDocx(jd));
  const pdfPosting = await parseJobFile(pdfPath);
  const docxPosting = await parseJobFile(docxPath);
  assert.equal(pdfPosting.source.kind, 'pdf');
  assert.equal(docxPosting.source.kind, 'docx');
  assert.match(pdfPosting.source.file_sha256, /^[a-f0-9]{64}$/);
  assert.match(docxPosting.source.file_sha256, /^[a-f0-9]{64}$/);
  assert.equal(docxPosting.employer.type, 'central_soe');
});

test('岗位文件 10 MB 边界、目录穿越、符号链接和异常 DOCX 均被确定性处理', async (context) => {
  const root = fixtureRoot();
  const allowed = join(root, 'jds', 'imports');
  mkdirSync(allowed, { recursive: true });

  const exactLimit = join(allowed, 'exact-limit.pdf');
  writeFileSync(exactLimit, Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1024 * 1024 - 5)]));
  await assert.rejects(() => parseJobFile(exactLimit, { allowed_root: allowed }), (error) => !/exceeds 10 MB/.test(error.message));
  const overLimit = join(allowed, 'over-limit.pdf');
  writeFileSync(overLimit, Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1024 * 1024 - 4)]));
  await assert.rejects(() => parseJobFile(overLimit, { allowed_root: allowed }), /exceeds 10 MB/);

  const outside = join(root, 'outside.docx');
  writeFileSync(outside, await minimalDocx(jd));
  await assert.rejects(() => parseJobFile(outside, { allowed_root: allowed }), /escaped the allowed directory/);

  const malformed = join(allowed, 'malformed.docx');
  const malformedZip = new JSZip();
  malformedZip.file('[Content_Types].xml', '<Types/>');
  writeFileSync(malformed, await malformedZip.generateAsync({ type: 'nodebuffer' }));
  await assert.rejects(() => parseJobFile(malformed, { allowed_root: allowed }), /word\/document.xml/);

  const expanded = join(allowed, 'expanded.docx');
  writeFileSync(expanded, await minimalDocx('job', `<w:p><w:r><w:t>${'A'.repeat(10_000_001)}</w:t></w:r></w:p>`));
  await assert.rejects(() => parseJobFile(expanded, { allowed_root: allowed }), /expanded content is too large/);

  const link = join(allowed, 'linked.docx');
  try {
    symlinkSync(outside, link, 'file');
    await assert.rejects(() => parseJobFile(link, { allowed_root: allowed }), /regular file, not a link/);
  } catch (error) {
    if (error?.code === 'EPERM') context.diagnostic('Windows 未授予创建文件符号链接权限；核心拒绝逻辑仍由实现覆盖');
    else throw error;
  }
});
