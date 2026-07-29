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
const schemaPath = join(ROOT, 'schemas', 'cn', 'candidate-profile.schema.json');
if (!existsSync(schemaPath)) {
  const error = new Error(`CandidateProfile Schema not found: ${schemaPath}`);
  error.code = 'SCHEMA_MISSING';
  throw error;
}
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
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
    schema_version: 2,
    candidate: { display_name: displayName },
    structured: {
      education: {},
      language_certificates: [],
      credentials: [],
      preferences: {},
    },
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
  'grade',
  'ranking',
  'certificate',
  'award',
  'internship',
  'employment',
  'affiliation',
  'result',
  'quantified_result',
]);

export const STRONG_EVIDENCE_KINDS = new Set([
  'repository',
  'document',
  'transcript',
  'certificate',
  'official_link',
]);

export const FORBIDDEN_RESUME_STATEMENT_PATTERN = /身份证(?:号)?|证件号|家庭成员|家庭住址|详细地址|完整住址|户籍地址|通讯地址|收货地址/i;
const SAFE_BASIC_SUBTYPES = new Set(['email', 'phone', 'city_region']);
const DETAILED_ADDRESS_PATTERN = /\d|号|栋|幢|单元|室|楼|路|街|巷|弄|大道|小区|社区|村|镇|乡|门牌/i;

function safeBasicFact(fact) {
  if (!SAFE_BASIC_SUBTYPES.has(fact.subtype)) return false;
  if (fact.subtype === 'email') return /^[^\s：:]+@[^\s：:]+\.[^\s：:]+$/.test(fact.statement.replace(/^邮箱\s*[：:]\s*/i, ''));
  if (fact.subtype === 'phone') return /^\+?[0-9][0-9\s-]{5,19}$/.test(fact.statement.replace(/^(?:电话|手机)\s*[：:]\s*/i, ''));
  return fact.statement.length <= 30 && !DETAILED_ADDRESS_PATTERN.test(fact.statement);
}

function isVerifiableStrongEvidence(evidence) {
  return evidence.strength === 'strong'
    && STRONG_EVIDENCE_KINDS.has(evidence.kind)
    && (typeof evidence.sha256 === 'string' || /^https:\/\//i.test(evidence.ref));
}

function isUsableEvidence(evidence) {
  if (evidence.integrity_valid === false) return false;
  if (evidence.kind === 'user_confirmation') return /^confirmation:/i.test(evidence.ref);
  return typeof evidence.sha256 === 'string' || /^https:\/\//i.test(evidence.ref);
}

export function evaluateFactEligibility(fact, evidenceById, use = 'resume') {
  const reasons = [];
  if (fact.status !== 'confirmed') reasons.push(`status_${fact.status}`);
  if (!fact.allowed_uses?.includes(use)) reasons.push('use_not_allowed');
  if (use === 'resume' && FORBIDDEN_RESUME_STATEMENT_PATTERN.test(fact.statement)) reasons.push('forbidden_sensitive_content');
  if (use === 'resume' && fact.type === 'basic' && !safeBasicFact(fact)) reasons.push('basic_requires_safe_subtype');

  const referenced = (fact.evidence_ids || []).map((id) => evidenceById.get(id)).filter(Boolean);
  if (referenced.length !== (fact.evidence_ids || []).length || referenced.length === 0) {
    reasons.push('missing_evidence');
  }
  if (referenced.some((item) => item.integrity_reason === 'hash_mismatch')) {
    reasons.push('evidence_integrity_mismatch');
  } else if (referenced.some((item) => !isUsableEvidence(item))) {
    reasons.push('evidence_unverifiable');
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
  if (![1, 2].includes(profile?.schema_version)) {
    errors.push({ code: 'unsupported_schema_version', version: profile?.schema_version });
    return { valid: false, errors };
  }
  if (!validateSchema(profile)) errors.push(...schemaErrors());

  const factIds = new Set();
  for (const fact of profile?.facts || []) {
    if (factIds.has(fact.id)) errors.push({ code: 'duplicate_fact_id', id: fact.id });
    if (fact.subtype && fact.type !== 'basic') errors.push({ code: 'subtype_only_allowed_for_basic_fact', id: fact.id });
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

  if (profile?.schema_version === 2) {
    for (const reference of structuredFactReferences(profile.structured)) {
      const fact = profile.facts.find((item) => item.id === reference.fact_id);
      if (!fact) {
        errors.push({ code: 'structured_fact_missing', path: reference.path, fact_id: reference.fact_id });
        continue;
      }
      if (fact.status !== 'confirmed') {
        errors.push({ code: 'structured_fact_not_confirmed', path: reference.path, fact_id: reference.fact_id });
      }
      if (!fact.evidence_ids?.length) {
        errors.push({ code: 'structured_fact_missing_evidence', path: reference.path, fact_id: reference.fact_id });
      }
      const referencedEvidence = (fact.evidence_ids || []).map((id) => profile.evidence.find((item) => item.id === id)).filter(Boolean);
      if (HIGH_RISK_FACT_TYPES.has(fact.type) && !referencedEvidence.some(isVerifiableStrongEvidence)) {
        errors.push({ code: 'structured_fact_requires_strong_evidence', path: reference.path, fact_id: reference.fact_id });
      }
      if (!fact.allowed_uses?.some((use) => use === 'job_match' || use === 'application_form')) {
        errors.push({ code: 'structured_fact_use_not_allowed', path: reference.path, fact_id: reference.fact_id });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function structuredFactReferences(structured) {
  if (!structured || typeof structured !== 'object') return [];
  const references = [];
  const visit = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}/${index}`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (typeof value.fact_id === 'string') {
      references.push({ path, fact_id: value.fact_id });
      return;
    }
    for (const [key, child] of Object.entries(value)) visit(child, `${path}/${key}`);
  };
  visit(structured, '/structured');
  return references;
}

export function migrateCandidateProfile(root) {
  const path = join(root, PROFILE_RELATIVE_PATH);
  if (!existsSync(path)) {
    const error = new Error('Candidate profile is missing; create or import Facts before migration');
    error.code = 'PROFILE_MISSING';
    throw error;
  }
  const profile = loadCandidateProfile(root);
  if (profile.schema_version === 2) {
    return { changed: false, profile, backup_path: null };
  }
  const migrated = {
    ...profile,
    schema_version: 2,
    structured: {
      education: {},
      language_certificates: [],
      credentials: [],
      preferences: {},
    },
  };
  const backupPath = `${path}.v1.bak`;
  if (!existsSync(backupPath)) copyFileSync(path, backupPath);
  writeProfile(root, migrated);
  return { changed: true, profile: migrated, backup_path: backupPath };
}

export function updateStructuredProfile(root, structured, { authorizeUses = false } = {}) {
  const profile = loadCandidateProfile(root);
  if (profile.schema_version !== 2) {
    const error = new Error('CandidateProfile v1 must be explicitly migrated before structured fields can be updated');
    error.code = 'PROFILE_MIGRATION_REQUIRED';
    throw error;
  }
  const next = structuredClone(profile);
  next.structured = structured;
  if (authorizeUses) {
    const referenced = new Set(structuredFactReferences(structured).map((item) => item.fact_id));
    for (const fact of next.facts) {
      if (!referenced.has(fact.id)) continue;
      fact.allowed_uses = [...new Set([...(fact.allowed_uses || []), 'job_match', 'application_form'])];
    }
  }
  writeProfile(root, next);
  return next;
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

export function buildJobMatchContext(root) {
  const profile = loadCandidateProfile(root);
  const facts = profile.facts.filter((fact) => fact.status === 'confirmed'
    && fact.allowed_uses?.includes('job_match')
    && !['sensitive', 'restricted'].includes(fact.sensitivity));
  const allowedFactIds = new Set(facts.map((fact) => fact.id));
  const prune = (value) => {
    if (Array.isArray(value)) return value.map(prune).filter((item) => item !== undefined);
    if (!value || typeof value !== 'object') return value;
    if (typeof value.fact_id === 'string') return allowedFactIds.has(value.fact_id) ? value : undefined;
    const entries = Object.entries(value).map(([key, child]) => [key, prune(child)]).filter(([, child]) => child !== undefined);
    return Object.fromEntries(entries);
  };
  return {
    schema_version: profile.schema_version,
    facts: facts.map(({ id, type, statement }) => ({ id, type, statement })),
    structured: profile.schema_version === 2 ? prune(profile.structured) : null,
  };
}

function legacyFactType(section, statement = '') {
  if (/基本信息|联系方式|联系信息|邮箱|电话|手机|所在地|现居地|email|phone|contact|location/i.test(`${section} ${statement}`)) return 'basic';
  if (/排名|rank/i.test(`${section} ${statement}`)) return 'ranking';
  if (/成绩|绩点|gpa|grade/i.test(`${section} ${statement}`)) return 'grade';
  if (/教育|学历|education/i.test(section)) return 'education';
  if (/技能|skill/i.test(section)) return 'skill';
  if (/证书|certificate/i.test(section)) return 'certificate';
  if (/奖项|award/i.test(section)) return 'award';
  if (/校园|学生|campus/i.test(section)) return 'campus';
  if (/实习|intern/i.test(section)) return 'internship';
  if (/任职单位|所属单位|affiliation/i.test(section)) return 'affiliation';
  if (/工作|任职|就业|employment/i.test(section)) return 'employment';
  if (/\d+(?:\.\d+)?\s*(?:%|％|倍|人|项|个|万|千|元|秒|分钟|小时)/i.test(statement)) return 'quantified_result';
  return 'project';
}

function legacyBasicSubtype(statement) {
  const value = statement.trim();
  if (/^(?:邮箱\s*[：:]\s*)?[^\s：:]+@[^\s：:]+\.[^\s：:]+$/i.test(value)) return 'email';
  if (/^(?:(?:电话|手机)\s*[：:]\s*)?\+?[0-9][0-9\s-]{5,19}$/i.test(value)) return 'phone';
  if (/^(?:(?:所在地|现居地)\s*[：:]\s*)?[^\d号栋幢单元室楼路街巷弄大道小区社区村镇乡门牌]{2,30}$/i.test(value)) return 'city_region';
  return undefined;
}

function parseLegacyFacts(markdown) {
  let section = 'legacy';
  const factsById = new Map();
  const lines = markdown.split(/\r?\n/);
  const addFact = (statement) => {
    const clean = statement.replace(/<!--\s*fact:[^>]+-->/g, '').trim();
    if (!clean) return;
    const id = `legacy.${sha256(`${section}\n${clean}`).slice(0, 16)}`;
    if (factsById.has(id)) return;
    const type = legacyFactType(section, clean);
    const subtype = type === 'basic' ? legacyBasicSubtype(clean) : undefined;
    factsById.set(id, {
      id,
      type,
      ...(subtype ? { subtype } : {}),
      statement: clean,
      status: 'unconfirmed',
      sensitivity: 'personal',
      allowed_uses: ['resume'],
      evidence_ids: [],
      source: 'cv.md',
    });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const heading = rawLine.match(/^#{2,6}\s+(.+?)\s*$/);
    if (heading) {
      section = heading[1];
      continue;
    }
    const bullet = rawLine.match(/^\s*[-*+]\s+(.+?)\s*$/);
    if (bullet) {
      addFact(bullet[1]);
      continue;
    }
    const trimmed = rawLine.trim();
    if (!trimmed || /^#\s+/.test(trimmed) || /^<!--/.test(trimmed)) continue;
    if (trimmed.includes('|')) {
      if (/^\|?\s*:?-{3,}/.test(trimmed)) continue;
      if (lines[index + 1] && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) continue;
      addFact(trimmed.split('|').map((cell) => cell.trim()).filter(Boolean).join('；'));
      continue;
    }
    addFact(trimmed);
  }
  return [...factsById.values()];
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
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(storedEvidence.verified_at)
    || Number.isNaN(Date.parse(storedEvidence.verified_at))) {
    throw new Error('Candidate profile validation failed: Evidence verified_at must be an ISO date-time');
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(storedEvidence.ref)) {
    const evidencePath = resolve(root, storedEvidence.ref);
    const evidenceRoot = resolve(root, 'profile', 'evidence');
    if (evidencePath !== evidenceRoot && !evidencePath.startsWith(`${evidenceRoot}${sep}`)) {
      throw new Error('Local Evidence files must be stored under profile/evidence');
    }
    if (!existsSync(evidencePath)) throw new Error(`Evidence file not found: ${storedEvidence.ref}`);
    storedEvidence.ref = relative(root, evidencePath).replace(/\\/g, '/');
    storedEvidence.sha256 = sha256(readFileSync(evidencePath));
  } else if (storedEvidence.kind === 'user_confirmation') {
    if (!/^confirmation:/i.test(storedEvidence.ref)) throw new Error('User confirmation Evidence must use a confirmation: reference');
  } else if (!/^https:\/\//i.test(storedEvidence.ref)) {
    throw new Error('Remote Evidence must use an HTTPS reference');
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

function evidenceForPolicy(root, profile) {
  return new Map(profile.evidence.map((item) => {
    const checked = { ...item };
    if (item.sha256 && !/^[a-z][a-z0-9+.-]*:/i.test(item.ref)) {
      const evidencePath = resolve(root, item.ref);
      checked.integrity_valid = existsSync(evidencePath) && sha256(readFileSync(evidencePath)) === item.sha256;
      if (!checked.integrity_valid) checked.integrity_reason = 'hash_mismatch';
    }
    return [item.id, checked];
  }));
}

function buildCvProjection(profile, evidenceById) {
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
  const profile = loadCandidateProfile(root);
  return buildCvProjection(profile, evidenceForPolicy(root, profile));
}

export function projectCv(root) {
  const profilePath = join(root, PROFILE_RELATIVE_PATH);
  if (!existsSync(profilePath)) {
    const error = new Error('Candidate profile is missing; import or create Facts before projection');
    error.code = 'PROFILE_MISSING';
    throw error;
  }
  const projection = previewCv(root);
  const manifest = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source_profile: PROFILE_RELATIVE_PATH.replace(/\\/g, '/'),
    fact_ids: projection.fact_ids,
    profile_sha256: sha256(readFileSync(profilePath)),
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
  const evidenceById = evidenceForPolicy(root, profile);
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
  const profilePath = join(root, PROFILE_RELATIVE_PATH);
  if (!existsSync(profilePath) || manifest.profile_sha256 !== sha256(readFileSync(profilePath))) {
    return { valid: false, reason: 'profile_hash_mismatch' };
  }
  const contentHash = sha256(readFileSync(cvPath, 'utf8'));
  if (manifest.content_sha256 !== contentHash) return { valid: false, reason: 'cv_hash_mismatch' };
  return { valid: true, reason: null };
}
