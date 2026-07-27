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
    reasons: ['high_risk_requires_strong_evidence'],
  });
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

test('Fact status transitions reject impossible direct recovery from rejected to confirmed', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerpilot-status-'));
  importCvMarkdown(root, '# 匿名候选人\n\n## 项目经历\n\n- 完成匿名校园项目\n');
  const fact = loadCandidateProfile(root).facts[0];
  updateFactStatus(root, fact.id, 'rejected');
  assert.throws(() => updateFactStatus(root, fact.id, 'confirmed'), /Invalid Fact status transition/);
  updateFactStatus(root, fact.id, 'unconfirmed');
  assert.equal(loadCandidateProfile(root).facts[0].status, 'unconfirmed');
});

test('tracked anonymous sample satisfies the same CandidateProfile schema', () => {
  const samplePath = join(import.meta.dirname, 'examples', 'cn-profile', 'candidate.yml');
  const sample = yaml.load(readFileSync(samplePath, 'utf8'));
  assert.deepEqual(validateCandidateProfile(sample), { valid: true, errors: [] });
});
