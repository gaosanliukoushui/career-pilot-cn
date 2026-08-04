#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { confirmJobPosting, evaluateJob, loadJobRecord, saveJobEvaluation } from './lib/careerpilot/job-core.mjs';
import {
  createCampaign,
  confirmCampaignConstraints,
  excludeCampaignJob,
  importCampaignSources,
  listCampaigns,
  loadCampaign,
  rankCampaign,
  selectCampaignJobs,
  validateCampaign,
} from './lib/careerpilot/campaign-core.mjs';

function profileFixture() {
  const facts = [
    ['education.degree', 'education', '本科学历'],
    ['education.major', 'education', '软件工程专业'],
    ['education.cohort', 'education', '2027届毕业生'],
    ['skill.java', 'skill', '掌握 Java 后端开发'],
  ].map(([id, type, statement]) => ({
    id, type, statement, status: 'confirmed', sensitivity: 'personal',
    allowed_uses: ['resume', 'application_form', 'job_match'], evidence_ids: [`evidence.${id}`],
  }));
  return {
    schema_version: 2,
    candidate: { display_name: '匿名候选人' },
    structured: {
      education: {
        degree: { value: 'bachelor', fact_id: 'education.degree' },
        major_name: { value: '软件工程', fact_id: 'education.major' },
        cohort: { value: 2027, fact_id: 'education.cohort' },
      },
      language_certificates: [], credentials: [], preferences: {},
    },
    facts,
    evidence: facts.map((item) => ({
      id: `evidence.${item.id}`, kind: 'official_link', ref: `https://example.invalid/${item.id}`,
      strength: 'strong', verified_at: '2026-08-04T00:00:00.000Z',
    })),
  };
}

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-campaign-'));
  mkdirSync(join(root, 'profile'), { recursive: true });
  writeFileSync(join(root, 'profile', 'candidate.yml'), yaml.dump(profileFixture()), 'utf8');
  return root;
}

function jd(title, code, extra = '') {
  return [
    '招聘单位：示例汽车科技公司', `岗位名称：${title}`, `岗位代码：${code}`,
    '面向2027届应届毕业生校园招聘', '学历要求：本科及以上', '专业要求：软件工程、计算机科学与技术',
    extra,
  ].filter(Boolean).join('\n');
}

function confirmed(posting, status = 'active') {
  const reviewed = structuredClone(posting);
  reviewed.rules = reviewed.rules.map((rule) => ({ ...rule, confirmation_status: 'confirmed' }));
  reviewed.posting_status = status;
  return confirmJobPosting(reviewed, { official_source_confirmed: true, official_source_evidence: '招聘单位官方校园招聘平台' });
}

test('用户可创建带已确认限投约束的私有 Campaign', () => {
  const root = fixtureRoot();
  const campaign = createCampaign(root, {
    name: '示例汽车 2027 校招岗位对比', employer: '示例汽车科技公司', recruitment_batch: '2027校园招聘',
    max_applications: 1, constraint_confirmation_status: 'confirmed', constraint_source_quote: '本次校园招聘仅允许投递1次',
  });
  assert.match(campaign.id, /^campaign\.[a-f0-9]{24}$/);
  assert.equal(campaign.constraints[0].value, 1);
  assert.equal(campaign.constraints[0].confirmation_status, 'confirmed');
  assert.deepEqual(validateCampaign(campaign), { valid: true, errors: [] });
  assert.equal(listCampaigns(root).length, 1);
  assert.ok(existsSync(join(root, 'data', 'careerpilot', 'campaigns', `${campaign.id}.json`)));
});

test('已确认互斥岗位约束阻止选择同组岗位但允许其他组合', async () => {
  const root = fixtureRoot();
  const campaign = createCampaign(root, {
    name: '互斥岗位', employer: '示例汽车科技公司', max_applications: 2,
    constraint_confirmation_status: 'confirmed', constraint_source_quote: '最多投递两个岗位',
  });
  const imported = await importCampaignSources(root, campaign.id, [
    { kind: 'text', text: jd('岗位甲', 'A-01') },
    { kind: 'text', text: jd('岗位乙', 'B-02') },
    { kind: 'text', text: jd('岗位丙', 'C-03') },
  ]);
  for (const jobId of imported.imported) {
    const posting = confirmed(loadJobRecord(root, jobId).posting);
    saveJobEvaluation(root, posting, evaluateJob(root, posting));
  }
  confirmCampaignConstraints(root, campaign.id, {
    mutually_exclusive: [{ job_ids: imported.imported.slice(0, 2), source_quote: '岗位甲与岗位乙不可同时投递' }],
  });
  rankCampaign(root, campaign.id);
  assert.throws(
    () => selectCampaignJobs(root, campaign.id, imported.imported.slice(0, 2), { reason: '错误组合' }),
    (error) => error.code === 'CAMPAIGN_MUTUAL_EXCLUSION',
  );
  const allowed = selectCampaignJobs(root, campaign.id, [imported.imported[0], imported.imported[2]], { reason: '非互斥组合' });
  assert.equal(allowed.selection.status, 'confirmed');
});

test('批量导入保留成功项并按 URL、最终 URL 和内容哈希去重', async () => {
  const root = fixtureRoot();
  const campaign = createCampaign(root, { name: '批量导入', employer: '示例汽车科技公司', max_applications: 1 });
  const result = await importCampaignSources(root, campaign.id, [
    { kind: 'browser_capture', url: 'https://jobs.example/a', title: 'AI应用开发', captured_text: jd('AI应用开发', 'AI-01'), captured_at: '2026-08-04T01:00:00.000Z', provider: 'codex-edge' },
    { kind: 'browser_capture', url: 'https://jobs.example/a', title: '重复标签', captured_text: jd('AI应用开发', 'AI-01'), captured_at: '2026-08-04T01:01:00.000Z', provider: 'codex-edge' },
    { kind: 'text', text: jd('Java后端开发', 'JAVA-02') },
    { kind: 'text', text: '' },
  ]);
  assert.equal(result.imported.length, 2);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(loadCampaign(root, campaign.id).jobs.length, 2);
  for (const jobId of result.imported) assert.equal(loadJobRecord(root, jobId).report, null);
});

test('Campaign 只有在岗位均确认评估后才能稳定排名并限量选岗', async () => {
  const root = fixtureRoot();
  const campaign = createCampaign(root, {
    name: '岗位排名', employer: '示例汽车科技公司', max_applications: 1,
    constraint_confirmation_status: 'confirmed', constraint_source_quote: '最多投递一个岗位',
  });
  const imported = await importCampaignSources(root, campaign.id, [
    { kind: 'text', text: jd('AI应用开发', 'AI-01') },
    { kind: 'text', text: jd('Java后端开发', 'JAVA-02') },
  ]);
  assert.throws(() => rankCampaign(root, campaign.id), (error) => error.code === 'CAMPAIGN_NOT_READY');

  const scores = [4.6, 4.1];
  for (const [index, jobId] of imported.imported.entries()) {
    const posting = confirmed(loadJobRecord(root, jobId).posting);
    const dimensions = ['role_major', 'evidence', 'career_direction', 'mobility', 'development', 'source_reliability']
      .map((id) => ({ id, score: id === 'source_reliability' ? 3 : scores[index], candidate_fact_ids: id === 'evidence' ? ['skill.java'] : [], rationale: '匿名验收事实' }));
    const report = evaluateJob(root, posting, { dimensions, strengths: ['已有证据'], gaps: index ? ['缺少岗位项目'] : [] });
    saveJobEvaluation(root, posting, report);
  }
  const ranked = rankCampaign(root, campaign.id);
  assert.equal(ranked.ranking.status, 'ready');
  assert.ok(ranked.jobs.every((item) => item.match_report_id && /^[a-f0-9]{64}$/.test(item.match_report_sha256)));
  assert.deepEqual(ranked.ranking.entries.map((item) => item.job_id), imported.imported);
  assert.equal(ranked.ranking.entries[0].rank, 1);
  const selected = selectCampaignJobs(root, campaign.id, [imported.imported[0]], { reason: '综合排名第一' });
  assert.equal(selected.selection.status, 'confirmed');
  assert.deepEqual(selected.selection.job_ids, [imported.imported[0]]);
  assert.throws(
    () => selectCampaignJobs(root, campaign.id, imported.imported, { reason: '尝试超额选择' }),
    (error) => error.code === 'CAMPAIGN_SELECTION_LIMIT',
  );

  const matchPath = join(root, 'data', 'careerpilot', 'matches', `${imported.imported[0]}.json`);
  const changedReport = JSON.parse(readFileSync(matchPath, 'utf8'));
  changedReport.evaluated_at = '2026-08-04T23:59:59.000Z';
  writeFileSync(matchPath, `${JSON.stringify(changedReport, null, 2)}\n`, 'utf8');
  assert.throws(
    () => selectCampaignJobs(root, campaign.id, [imported.imported[0]], { reason: 'changed report must invalidate selection' }),
    (error) => error.code === 'CAMPAIGN_RANKING_STALE' && error.details.some((item) => item.code === 'match_report_changed'),
  );
});

test('关闭岗位必须明确排除；Profile 变化会使既有排名和选择失效', async () => {
  const root = fixtureRoot();
  const campaign = createCampaign(root, {
    name: '失效检查', employer: '示例汽车科技公司', max_applications: 1,
    constraint_confirmation_status: 'confirmed', constraint_source_quote: '最多投递一个岗位',
  });
  const imported = await importCampaignSources(root, campaign.id, [
    { kind: 'text', text: jd('AI应用开发', 'AI-01') },
    { kind: 'text', text: jd('已关闭岗位', 'CLOSED-02') },
  ]);
  for (const [index, jobId] of imported.imported.entries()) {
    const posting = confirmed(loadJobRecord(root, jobId).posting, index === 1 ? 'closed' : 'active');
    const report = evaluateJob(root, posting);
    saveJobEvaluation(root, posting, report);
  }
  assert.throws(() => rankCampaign(root, campaign.id), (error) => error.code === 'CAMPAIGN_NOT_READY');
  excludeCampaignJob(root, campaign.id, imported.imported[1], { reason: '官网已关闭' });
  rankCampaign(root, campaign.id);
  selectCampaignJobs(root, campaign.id, [imported.imported[0]], { reason: '唯一有效岗位' });

  const profilePath = join(root, 'profile', 'candidate.yml');
  writeFileSync(profilePath, `${readFileSync(profilePath, 'utf8')}\n# profile changed\n`, 'utf8');
  assert.throws(
    () => selectCampaignJobs(root, campaign.id, [imported.imported[0]], { reason: '使用过期排名' }),
    (error) => error.code === 'CAMPAIGN_RANKING_STALE',
  );
});

test('expired Campaign deadline blocks deterministic ranking', async () => {
  const root = fixtureRoot();
  const campaign = createCampaign(root, {
    name: 'Expired deadline', employer: 'Example employer', deadline: '2000-01-01', max_applications: 1,
    constraint_confirmation_status: 'confirmed', constraint_source_quote: 'Only one application is permitted.',
  });
  const imported = await importCampaignSources(root, campaign.id, [{ kind: 'text', text: jd('AI application', 'AI-EXPIRED') }]);
  const posting = confirmed(loadJobRecord(root, imported.imported[0]).posting);
  saveJobEvaluation(root, posting, evaluateJob(root, posting));
  assert.throws(
    () => rankCampaign(root, campaign.id),
    (error) => error.code === 'CAMPAIGN_NOT_READY' && error.details.some((item) => item.code === 'campaign_deadline_expired'),
  );
});

test('missing JobRecord exposes a stable machine error code', () => {
  const root = fixtureRoot();
  assert.throws(
    () => loadJobRecord(root, 'job.0123456789abcdef'),
    (error) => error.code === 'JOB_RECORD_NOT_FOUND',
  );
});
