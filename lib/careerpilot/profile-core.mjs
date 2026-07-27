import Ajv2020 from 'ajv/dist/2020.js';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'cn', 'candidate-profile.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

const PROFILE_RELATIVE_PATH = join('profile', 'candidate.yml');
const CV_MANIFEST_RELATIVE_PATH = join('profile', 'generated', 'cv.manifest.json');
const CV_BACKUP_RELATIVE_PATH = join('profile', 'migration', 'cv.md.original.md');

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function emptyProfile(displayName = '匿名候选人') {
  return {
    schema_version: 1,
    candidate: { display_name: displayName },
    facts: [],
    evidence: [],
  };
}

function atomicReplace(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, content, 'utf8');
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  renameSync(temporaryPath, path);
}

function writeProfile(root, profile) {
  const validation = validateCandidateProfile(profile);
  if (!validation.valid) {
    const error = new Error('Candidate profile validation failed');
    error.code = 'PROFILE_INVALID';
    error.details = validation.errors;
    throw error;
  }
  atomicReplace(join(root, PROFILE_RELATIVE_PATH), yaml.dump(profile, { noRefs: true, lineWidth: 120 }));
  return profile;
}

export const HIGH_RISK_FACT_TYPES = new Set([
  'education',
  'certificate',
  'award',
  'internship',
  'result',
]);

export const STRONG_EVIDENCE_KINDS = new Set([
  'repository',
  'document',
  'transcript',
  'certificate',
  'official_link',
]);

function isVerifiableStrongEvidence(evidence) {
  return evidence.strength === 'strong'
    && STRONG_EVIDENCE_KINDS.has(evidence.kind)
    && (typeof evidence.sha256 === 'string' || /^https:\/\//i.test(evidence.ref));
}

export function evaluateFactEligibility(fact, evidenceById, use = 'resume') {
  const reasons = [];
  if (fact.status !== 'confirmed') reasons.push(`status_${fact.status}`);
  if (!fact.allowed_uses?.includes(use)) reasons.push('use_not_allowed');

  const referenced = (fact.evidence_ids || []).map((id) => evidenceById.get(id)).filter(Boolean);
  if (referenced.length !== (fact.evidence_ids || []).length || referenced.length === 0) {
    reasons.push('missing_evidence');
  }

  if (
    HIGH_RISK_FACT_TYPES.has(fact.type)
    && referenced.length > 0
    && !referenced.some(isVerifiableStrongEvidence)
  ) {
    reasons.push('high_risk_requires_strong_evidence');
  }

  return { eligible: reasons.length === 0, reasons };
}

function schemaErrors() {
  return (validateSchema.errors || []).map((error) => ({
    code: 'schema_invalid',
    path: error.instancePath || '/',
    message: error.message || 'invalid value',
  }));
}

export function validateCandidateProfile(profile) {
  const errors = [];
  if (!validateSchema(profile)) errors.push(...schemaErrors());

  const factIds = new Set();
  for (const fact of profile?.facts || []) {
    if (factIds.has(fact.id)) errors.push({ code: 'duplicate_fact_id', id: fact.id });
    factIds.add(fact.id);
  }

  const evidenceIds = new Set();
  for (const evidence of profile?.evidence || []) {
    if (evidenceIds.has(evidence.id)) errors.push({ code: 'duplicate_evidence_id', id: evidence.id });
    evidenceIds.add(evidence.id);
  }

  const missing = new Set();
  for (const fact of profile?.facts || []) {
    for (const evidenceId of fact.evidence_ids || []) {
      if (!evidenceIds.has(evidenceId)) missing.add(evidenceId);
    }
  }
  for (const id of missing) errors.push({ code: 'missing_evidence', id });

  return { valid: errors.length === 0, errors };
}

export function loadCandidateProfile(root) {
  const path = join(root, PROFILE_RELATIVE_PATH);
  if (!existsSync(path)) return emptyProfile();
  const parsed = yaml.load(readFileSync(path, 'utf8'));
  const result = validateCandidateProfile(parsed);
  if (!result.valid) {
    const error = new Error('Candidate profile validation failed');
    error.code = 'PROFILE_INVALID';
    error.details = result.errors;
    throw error;
  }
  return parsed;
}

function legacyFactType(section) {
  if (/教育|学历|education/i.test(section)) return 'education';
  if (/技能|skill/i.test(section)) return 'skill';
  if (/证书|certificate/i.test(section)) return 'certificate';
  if (/奖项|award/i.test(section)) return 'award';
  if (/校园|学生|campus/i.test(section)) return 'campus';
  if (/实习|intern/i.test(section)) return 'internship';
  return 'project';
}

function parseLegacyFacts(markdown) {
  let section = 'legacy';
  const facts = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    const heading = rawLine.match(/^#{2,6}\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1];
      continue;
    }
    const bullet = rawLine.match(/^\s*[-*+]\s+(.+?)\s*$/);
    if (!bullet) continue;
    const statement = bullet[1].replace(/<!--\s*fact:[^>]+-->/g, '').trim();
    if (!statement) continue;
    facts.push({
      id: `legacy.${sha256(`${section}\n${statement}`).slice(0, 16)}`,
      type: legacyFactType(section),
      statement,
      status: 'unconfirmed',
      sensitivity: 'personal',
      allowed_uses: ['resume'],
      evidence_ids: [],
      source: 'cv.md',
    });
  }
  return facts;
}

export function importCvMarkdown(root, markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) throw new Error('CV markdown is required');
  const profile = loadCandidateProfile(root);
  const displayName = markdown.match(/^#\s+(?:CV\s*(?:--|—)\s*)?(.+?)\s*$/m)?.[1]?.trim();
  if (displayName) profile.candidate.display_name = displayName;

  const existingIds = new Set(profile.facts.map((fact) => fact.id));
  const candidates = parseLegacyFacts(markdown);
  const additions = candidates.filter((fact) => !existingIds.has(fact.id));
  profile.facts.push(...additions);

  const backupPath = join(root, CV_BACKUP_RELATIVE_PATH);
  if (!existsSync(backupPath)) {
    mkdirSync(dirname(backupPath), { recursive: true });
    writeFileSync(backupPath, markdown, 'utf8');
  }
  writeProfile(root, profile);
  return {
    imported: additions.length,
    total_candidates: candidates.length,
    backup_path: backupPath,
  };
}

export function attachEvidence(root, factId, evidence) {
  const profile = loadCandidateProfile(root);
  const fact = profile.facts.find((item) => item.id === factId);
  if (!fact) throw new Error(`Fact not found: ${factId}`);

  const storedEvidence = { ...evidence };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(storedEvidence.ref)) {
    const evidencePath = resolve(root, storedEvidence.ref);
    const evidenceRoot = resolve(root, 'profile', 'evidence');
    if (existsSync(evidencePath)) {
      if (evidencePath !== evidenceRoot && !evidencePath.startsWith(`${evidenceRoot}${sep}`)) {
        throw new Error('Local Evidence files must be stored under profile/evidence');
      }
      storedEvidence.ref = relative(root, evidencePath).replace(/\\/g, '/');
      storedEvidence.sha256 = sha256(readFileSync(evidencePath));
    }
  }

  const existing = profile.evidence.find((item) => item.id === storedEvidence.id);
  if (existing && JSON.stringify(existing) !== JSON.stringify(storedEvidence)) {
    throw new Error(`Evidence ID already exists: ${storedEvidence.id}`);
  }
  if (!existing) profile.evidence.push(storedEvidence);
  if (!fact.evidence_ids.includes(storedEvidence.id)) fact.evidence_ids.push(storedEvidence.id);
  writeProfile(root, profile);
  return { fact, evidence: existing || storedEvidence };
}

const ALLOWED_STATUS_TRANSITIONS = new Map([
  ['unconfirmed', new Set(['confirmed', 'rejected', 'conflicted'])],
  ['confirmed', new Set(['rejected', 'conflicted'])],
  ['rejected', new Set(['unconfirmed'])],
  ['conflicted', new Set(['confirmed', 'rejected', 'unconfirmed'])],
]);

export function updateFactStatus(root, factId, status) {
  const profile = loadCandidateProfile(root);
  const fact = profile.facts.find((item) => item.id === factId);
  if (!fact) throw new Error(`Fact not found: ${factId}`);
  if (fact.status !== status && !ALLOWED_STATUS_TRANSITIONS.get(fact.status)?.has(status)) {
    throw new Error(`Invalid Fact status transition: ${fact.status} -> ${status}`);
  }
  fact.status = status;
  writeProfile(root, profile);
  return fact;
}

function buildCvProjection(profile) {
  const evidenceById = new Map(profile.evidence.map((item) => [item.id, item]));
  const eligibleFacts = profile.facts.filter((fact) => evaluateFactEligibility(fact, evidenceById).eligible);
  const lines = [`# ${profile.candidate.display_name}`, ''];
  if (eligibleFacts.length) {
    lines.push('## 已核验经历', '');
    for (const fact of eligibleFacts) lines.push(`- ${fact.statement} <!-- fact:${fact.id} -->`);
    lines.push('');
  }
  const markdown = `${lines.join('\n').trimEnd()}\n`;
  return { markdown, fact_ids: eligibleFacts.map((fact) => fact.id) };
}

export function previewCv(root) {
  return buildCvProjection(loadCandidateProfile(root));
}

export function projectCv(root) {
  const projection = previewCv(root);
  const manifest = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source_profile: PROFILE_RELATIVE_PATH.replace(/\\/g, '/'),
    fact_ids: projection.fact_ids,
    content_sha256: sha256(projection.markdown),
  };
  const { markdown } = projection;
  atomicReplace(join(root, 'cv.md'), markdown);
  atomicReplace(join(root, CV_MANIFEST_RELATIVE_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
  return { markdown, manifest };
}

export function auditCandidateProfile(root, use = 'resume') {
  const profile = loadCandidateProfile(root);
  const validation = validateCandidateProfile(profile);
  const evidenceById = new Map(profile.evidence.map((item) => [item.id, item]));
  const facts = profile.facts.map((fact) => ({
    id: fact.id,
    ...evaluateFactEligibility(fact, evidenceById, use),
  }));
  return {
    valid: validation.valid && facts.every((fact) => fact.eligible),
    schema: validation,
    facts,
  };
}

export function auditProjectedCv(root) {
  const cvPath = join(root, 'cv.md');
  const manifestPath = join(root, CV_MANIFEST_RELATIVE_PATH);
  if (!existsSync(cvPath) || !existsSync(manifestPath)) return { valid: false, reason: 'projection_missing' };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const contentHash = sha256(readFileSync(cvPath, 'utf8'));
  if (manifest.content_sha256 !== contentHash) return { valid: false, reason: 'cv_hash_mismatch' };
  return { valid: true, reason: null };
}
