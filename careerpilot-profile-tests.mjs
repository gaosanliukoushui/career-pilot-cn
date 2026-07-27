import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  attachEvidence,
  auditCandidateProfile,
  auditProjectedCv,
  evaluateFactEligibility,
  importCvMarkdown,
  loadCandidateProfile,
  projectCv,
  updateFactStatus,
  validateCandidateProfile,
} from './lib/careerpilot/profile-core.mjs';

const baseFact = {
  id: 'project.campus_service.backend',
  type: 'project',
  statement: '参与校园服务平台后端接口开发',
  status: 'confirmed',
  sensitivity: 'personal',
  allowed_uses: ['resume'],
  evidence_ids: ['evidence.project.repo'],
};

test('confirmed ordinary Fact with user confirmation can be published', () => {
  const evidence = new Map([
    ['evidence.project.repo', {
      id: 'evidence.project.repo',
      kind: 'user_confirmation',
      ref: 'confirmation:2026-07-27',
      strength: 'ordinary',
      verified_at: '2026-07-27T12:00:00.000Z',
    }],
  ]);
  assert.deepEqual(evaluateFactEligibility(baseFact, evidence), { eligible: true, reasons: [] });
});

test('high-risk Fact cannot be published with user confirmation alone', () => {
  const fact = { ...baseFact, id: 'education.degree', type: 'education' };
  const evidence = new Map([
    ['evidence.project.repo', {
      id: 'evidence.project.repo',
      kind: 'user_confirmation',
      ref: 'confirmation:2026-07-27',
      strength: 'ordinary',
      verified_at: '2026-07-27T12:00:00.000Z',
    }],
  ]);
  assert.deepEqual(evaluateFactEligibility(fact, evidence), {
    eligible: false,
    reasons: ['high_risk_requires_strong_evidence'],
  });
});

test('high-risk Fact cannot use a missing local document as strong Evidence', () => {
  const fact = { ...baseFact, id: 'education.degree', type: 'education' };
  const evidence = new Map([
    ['evidence.project.repo', {
      id: 'evidence.project.repo',
      kind: 'document',
      ref: 'profile/evidence/missing.pdf',
      strength: 'strong',
      verified_at: '2026-07-27T12:00:00.000Z',
    }],
  ]);
  assert.deepEqual(evaluateFactEligibility(fact, evidence), {
    eligible: false,
    reasons: ['evidence_unverifiable', 'high_risk_requires_strong_evidence'],
  });
});

test('all specified high-risk Fact classes reject user confirmation alone', () => {
  const evidence = new Map([['evidence.project.repo', {
    id: 'evidence.project.repo',
    kind: 'user_confirmation',
    ref: 'confirmation:2026-07-27',
    strength: 'ordinary',
    verified_at: '2026-07-27T12:00:00.000Z',
  }]]);
  for (const type of ['education', 'grade', 'ranking', 'certificate', 'award', 'internship', 'employment', 'affiliation', 'result', 'quantified_result']) {
    const outcome = evaluateFactEligibility({ ...baseFact, id: `risk.${type}`, type }, evidence);
    assert.equal(outcome.eligible, false, `${type} unexpectedly passed`);
    assert.ok(outcome.reasons.includes('high_risk_requires_strong_evidence'));
  }
});

test('candidate aggregate rejects duplicate IDs and broken Evidence references', () => {
  const result = validateCandidateProfile({
    schema_version: 1,
    candidate: { display_name: '匿名候选人' },
    facts: [baseFact, { ...baseFact }],
    evidence: [],
  });
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map((item) => item.code).sort(), ['duplicate_fact_id', 'missing_evidence']);
});

test('legacy CV migration is unconfirmed and idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-import-'));
  const markdown = '# 匿名候选人\n\n## 项目经历\n\n- 参与校园服务平台后端接口开发\n';
  writeFileSync(join(root, 'cv.md'), markdown, 'utf8');

  const first = importCvMarkdown(root, markdown);
  const second = importCvMarkdown(root, markdown);
  const profile = loadCandidateProfile(root);

  assert.equal(first.imported, 1);
  assert.equal(second.imported, 0);
  assert.equal(profile.facts.length, 1);
  assert.equal(profile.facts[0].status, 'unconfirmed');
  assert.ok(first.backup_path);
  assert.equal(readFileSync(first.backup_path, 'utf8'), markdown);
});

test('legacy migration deduplicates repeated bullets and retains plain paragraphs', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-import-shapes-'));
  const markdown = '# 匿名候选人\n\n## 项目经历\n\n- 完成匿名项目\n- 完成匿名项目\n负责接口联调与测试。\n';
  const result = importCvMarkdown(root, markdown);
  const statements = loadCandidateProfile(root).facts.map((fact) => fact.statement);
  assert.equal(result.imported, 2);
  assert.deepEqual(statements, ['完成匿名项目', '负责接口联调与测试。']);
});

test('legacy migration classifies grades, rankings, employment, and quantified outcomes as high risk', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-import-risk-'));
  const markdown = [
    '# 匿名候选人',
    '## 成绩与排名',
    '- GPA 3.9，专业排名前 5%',
    '## 工作经历',
    '- 在匿名单位参与系统维护',
    '## 项目经历',
    '- 将接口响应时间降低 30%',
  ].join('\n');
  importCvMarkdown(root, markdown);
  const profile = loadCandidateProfile(root);
  assert.deepEqual(profile.facts.map((fact) => fact.type), ['ranking', 'employment', 'quantified_result']);
  for (const fact of profile.facts) {
    attachEvidence(root, fact.id, {
      id: `evidence.${fact.id}`,
      kind: 'user_confirmation',
      ref: `confirmation:${fact.id}`,
      strength: 'ordinary',
      verified_at: '2026-07-27T12:00:00.000Z',
    });
    updateFactStatus(root, fact.id, 'confirmed');
  }
  assert.doesNotMatch(projectCv(root).markdown, /GPA|匿名单位|30%/);
});

test('confirmed Fact projects to traceable cv.md and tampering is detected', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-project-'));
  const markdown = '# 匿名候选人\n\n## 项目经历\n\n- 参与校园服务平台后端接口开发\n';
  importCvMarkdown(root, markdown);
  const fact = loadCandidateProfile(root).facts[0];
  attachEvidence(root, fact.id, {
    id: 'evidence.user.confirmation',
    kind: 'user_confirmation',
    ref: 'confirmation:2026-07-27',
    strength: 'ordinary',
    verified_at: '2026-07-27T12:00:00.000Z',
  });
  updateFactStatus(root, fact.id, 'confirmed');

  const projected = projectCv(root);
  assert.match(projected.markdown, new RegExp(`<!-- fact:${fact.id} -->`));
  assert.match(projected.markdown, /参与校园服务平台后端接口开发/);
  assert.deepEqual(auditProjectedCv(root), { valid: true, reason: null });

  writeFileSync(join(root, 'cv.md'), `${projected.markdown}\n手工改写`, 'utf8');
  assert.deepEqual(auditProjectedCv(root), { valid: false, reason: 'cv_hash_mismatch' });
});

test('projection audit detects profile changes made after cv.md generation', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-profile-drift-'));
  importCvMarkdown(root, '# 匿名候选人\n\n## 项目经历\n\n- 完成匿名校园项目\n');
  const fact = loadCandidateProfile(root).facts[0];
  attachEvidence(root, fact.id, {
    id: 'evidence.user.confirmation',
    kind: 'user_confirmation',
    ref: 'confirmation:profile-drift',
    strength: 'ordinary',
    verified_at: '2026-07-27T12:00:00.000Z',
  });
  updateFactStatus(root, fact.id, 'confirmed');
  projectCv(root);
  updateFactStatus(root, fact.id, 'conflicted');
  assert.deepEqual(auditProjectedCv(root), { valid: false, reason: 'profile_hash_mismatch' });
});

test('CLI and shared core expose the same aggregate and validation result', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-cli-'));
  const markdown = '# 匿名候选人\n\n## 项目经历\n\n- 完成匿名校园项目\n';
  writeFileSync(join(root, 'cv.md'), markdown, 'utf8');
  const imported = spawnSync(process.execPath, ['careerpilot.mjs', 'import-cv', '--root', root], {
    cwd: import.meta.dirname,
    encoding: 'utf8',
  });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout).imported, 1);

  const shown = spawnSync(process.execPath, ['careerpilot.mjs', 'show', '--root', root], {
    cwd: import.meta.dirname,
    encoding: 'utf8',
  });
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout), loadCandidateProfile(root));
});

test('CLI supports the Web import, review, evidence, projection, and audit workflow', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-cli-flow-'));
  const cwd = import.meta.dirname;
  const run = (args, input) => spawnSync(process.execPath, ['careerpilot.mjs', ...args, '--root', root], {
    cwd,
    input,
    encoding: 'utf8',
  });

  const imported = run(['import-cv', '--stdin'], '# 匿名候选人\n\n## 项目经历\n\n- 完成匿名校园项目\n');
  assert.equal(imported.status, 0, imported.stderr);
  const factId = loadCandidateProfile(root).facts[0].id;

  const attached = run([
    'attach-evidence', factId,
    '--id', 'evidence.user.confirmation',
    '--kind', 'user_confirmation',
    '--ref', 'confirmation:web-review',
    '--strength', 'ordinary',
  ]);
  assert.equal(attached.status, 0, attached.stderr);
  assert.equal(run(['set-status', factId, 'confirmed']).status, 0);
  assert.equal(run(['project-cv']).status, 0);
  assert.equal(run(['audit']).status, 0);
});

test('local Evidence files receive a SHA-256 integrity hash and audit explains blocked Facts', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-evidence-'));
  const markdown = '# 匿名候选人\n\n## 教育经历\n\n- 获得匿名大学学士学位\n';
  importCvMarkdown(root, markdown);
  const fact = loadCandidateProfile(root).facts[0];
  const evidencePath = join(root, 'profile', 'evidence', 'degree.txt');
  mkdirSync(join(root, 'profile', 'evidence'), { recursive: true });
  writeFileSync(evidencePath, 'anonymous degree evidence', 'utf8');
  attachEvidence(root, fact.id, {
    id: 'evidence.education.degree',
    kind: 'document',
    ref: 'profile/evidence/degree.txt',
    strength: 'strong',
    verified_at: '2026-07-27T12:00:00.000Z',
  });

  const stored = loadCandidateProfile(root).evidence[0];
  assert.match(stored.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(auditCandidateProfile(root).facts[0], {
    id: fact.id,
    eligible: false,
    reasons: ['status_unconfirmed'],
  });
});

test('changed local Evidence is blocked during audit and subsequent projection', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-evidence-drift-'));
  importCvMarkdown(root, '# 匿名候选人\n\n## 项目经历\n\n- 完成匿名校园项目\n');
  const fact = loadCandidateProfile(root).facts[0];
  const evidencePath = join(root, 'profile', 'evidence', 'project.txt');
  mkdirSync(join(root, 'profile', 'evidence'), { recursive: true });
  writeFileSync(evidencePath, 'original evidence', 'utf8');
  attachEvidence(root, fact.id, {
    id: 'evidence.project.file',
    kind: 'document',
    ref: 'profile/evidence/project.txt',
    strength: 'strong',
    verified_at: '2026-07-27T12:00:00.000Z',
  });
  updateFactStatus(root, fact.id, 'confirmed');
  writeFileSync(evidencePath, 'changed evidence', 'utf8');

  const audit = auditCandidateProfile(root);
  assert.deepEqual(audit.facts[0].reasons, ['evidence_integrity_mismatch']);
  assert.doesNotMatch(projectCv(root).markdown, /完成匿名校园项目/);
});

test('Fact status transitions reject impossible direct recovery from rejected to confirmed', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-status-'));
  importCvMarkdown(root, '# 匿名候选人\n\n## 项目经历\n\n- 完成匿名校园项目\n');
  const fact = loadCandidateProfile(root).facts[0];
  updateFactStatus(root, fact.id, 'rejected');
  assert.throws(() => updateFactStatus(root, fact.id, 'confirmed'), /Invalid Fact status transition/);
  updateFactStatus(root, fact.id, 'unconfirmed');
  assert.equal(loadCandidateProfile(root).facts[0].status, 'unconfirmed');
});

test('Evidence write rejects missing or escaping local files and invalid verification time', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-evidence-input-'));
  importCvMarkdown(root, '# 匿名候选人\n\n## 项目经历\n\n- 完成匿名项目\n');
  const fact = loadCandidateProfile(root).facts[0];
  const baseEvidence = {
    id: 'evidence.invalid',
    kind: 'document',
    strength: 'strong',
    verified_at: '2026-07-27T12:00:00.000Z',
  };
  assert.throws(() => attachEvidence(root, fact.id, { ...baseEvidence, ref: 'profile/evidence/missing.pdf' }), /not found/);
  assert.throws(() => attachEvidence(root, fact.id, { ...baseEvidence, ref: '../outside.pdf' }), /profile\/evidence/);
  assert.throws(() => attachEvidence(root, fact.id, {
    id: 'evidence.invalid-time',
    kind: 'official_link',
    ref: 'https://example.invalid/evidence',
    strength: 'strong',
    verified_at: 'x',
  }), /validation failed/);
});

test('project-cv returns a PROFILE_MISSING domain error before reading absent files', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-missing-profile-'));
  assert.throws(
    () => projectCv(root),
    (error) => error.code === 'PROFILE_MISSING',
  );
});

test('tracked anonymous sample satisfies the same CandidateProfile schema', () => {
  const samplePath = join(import.meta.dirname, 'examples', 'cn-profile', 'candidate.yml');
  const sample = yaml.load(readFileSync(samplePath, 'utf8'));
  assert.deepEqual(validateCandidateProfile(sample), { valid: true, errors: [] });
});

test('unsupported Schema versions return a dedicated validation error', () => {
  const result = validateCandidateProfile({
    schema_version: 2,
    candidate: { display_name: '匿名候选人' },
    facts: [],
    evidence: [],
  });
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, 'unsupported_schema_version');
});
