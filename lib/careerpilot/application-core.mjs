import Ajv2020 from 'ajv/dist/2020.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJobEvaluation } from './job-core.mjs';
import { loadCandidateProfile } from './profile-core.mjs';
import { formatReportNumber, releaseReportNumbers, reserveReportNumbers } from '../../reserve-report-num.mjs';
import { parseTrackerRow, resolveColumns } from '../../tracker-parse.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'cn', 'application.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);
const RESTRICTED_FIELD_IDS = new Set(['personal.identity_number', 'personal.family_members', 'personal.full_address']);
const RESTRICTED_TEXT_PATTERN = /\b\d{17}[\dXx]\b/g;

export const CN_STAGE_TO_CANONICAL = Object.freeze({
  evaluated: 'Evaluated',
  pending_apply: 'Evaluated',
  submitted: 'Applied',
  qualification: 'Responded',
  assessment_notice: 'Responded',
  written_test_notice: 'Responded',
  written_test_completed: 'Responded',
  interview_first: 'Interview',
  interview_professional: 'Interview',
  interview_hr: 'Interview',
  medical: 'Interview',
  background_review: 'Interview',
  political_review: 'Interview',
  intended_offer: 'Offer',
  signed: 'Hired',
  ineligible: 'SKIP',
  withdrawn: 'Discarded',
  closed: 'Discarded',
  expired: 'Discarded',
  rejected: 'Rejected',
});

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, 'utf8');
  renameSync(temporary, path);
}

function cleanText(value) {
  return String(value ?? '').replace(RESTRICTED_TEXT_PATTERN, '[需本人手工填写]').replace(/[\r\n\t]+/g, ' ').trim();
}

function trackerPath(root) {
  return join(root, 'data', 'applications.md');
}

function ensureTracker(root) {
  const path = trackerPath(root);
  if (!existsSync(path)) {
    atomicWrite(path, '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n');
  }
  return path;
}

function trackerRows(root) {
  const path = ensureTracker(root);
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const columns = resolveColumns(lines);
  return lines.map((line) => parseTrackerRow(line, columns)).filter(Boolean);
}

function trackerNumForJob(root, jobId) {
  return trackerRows(root).find((row) => String(row.notes || '').includes(`job:${jobId}`))?.num || null;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'job';
}

async function createTrackerEntry(root, posting, report) {
  const existing = trackerNumForJob(root, posting.id);
  if (existing) return existing;
  const tracker = ensureTracker(root);
  const additions = join(root, 'batch', 'tracker-additions');
  mkdirSync(additions, { recursive: true });
  const reserved = await reserveReportNumbers(1, { rootDir: root, trackerPath: tracker });
  const number = reserved[0];
  const formatted = formatReportNumber(number);
  const reportLink = `[${formatted}](${report.report_path})`;
  const note = `job:${posting.id}; CareerPilot CN qualification:${report.eligibility.result}`;
  const initialStatus = report.eligibility.result === 'ineligible' && !report.override ? 'SKIP' : 'Evaluated';
  const cells = [
    number,
    new Date().toISOString().slice(0, 10),
    posting.employer.name,
    posting.title,
    initialStatus,
    `${report.fit.score.toFixed(1)}/5`,
    '❌',
    reportLink,
    note,
  ];
  const additionPath = join(additions, `${formatted}-${slug(posting.employer.name)}.tsv`);
  writeFileSync(additionPath, `${cells.join('\t')}\n`, 'utf8');
  try {
    execFileSync(process.execPath, [join(ROOT, 'merge-tracker.mjs')], {
      cwd: ROOT,
      env: { ...process.env, CAREER_OPS_TRACKER: tracker, CAREER_OPS_ADDITIONS: additions },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    rmSync(additionPath, { force: true });
    throw new Error(`Unable to merge CareerPilot CN tracker entry: ${error.stderr?.toString() || error.message}`);
  } finally {
    await releaseReportNumbers(reserved, { rootDir: root, trackerPath: tracker });
  }
  return trackerNumForJob(root, posting.id) || number;
}

function structuredField(profile, path) {
  let value = profile.structured;
  for (const segment of path.split('.')) value = value?.[segment];
  return value || null;
}

function field({ id, label, category, sensitivity = 'personal', required = false, source = null, maxLength = null, draft }) {
  const restricted = RESTRICTED_FIELD_IDS.has(id) || sensitivity === 'restricted';
  const result = {
    id, label, category, required, sensitivity,
    manual_required: restricted || !source,
    source_fact_ids: source?.fact_id ? [source.fact_id] : [],
    max_length: maxLength,
  };
  if (!restricted && draft !== undefined) result.draft = draft;
  else if (!restricted && source?.value !== undefined) result.draft = source.value;
  return result;
}

function experienceDraft(profile) {
  const facts = profile.facts.filter((item) => ['internship', 'project', 'campus', 'employment'].includes(item.type) && item.status === 'confirmed' && item.allowed_uses.includes('application_form'));
  return {
    source: facts.length ? { fact_id: facts[0].id } : null,
    fact_ids: facts.map((item) => item.id),
    draft: facts.map((item) => item.statement).join('\n'),
  };
}

function buildFields(profile) {
  const education = profile.schema_version === 2 ? profile.structured.education : {};
  const experience = experienceDraft(profile);
  const location = profile.schema_version === 2 ? structuredField(profile, 'preferences.locations') : null;
  const fields = [
    field({ id: 'personal.display_name', label: '姓名', category: 'personal', required: true, source: { value: profile.candidate.display_name, fact_id: null } }),
    field({ id: 'personal.identity_number', label: '身份证号码', category: 'personal', required: true, sensitivity: 'restricted' }),
    field({ id: 'personal.full_address', label: '详细住址', category: 'personal', sensitivity: 'restricted' }),
    field({ id: 'personal.family_members', label: '家庭成员', category: 'personal', sensitivity: 'restricted' }),
    field({ id: 'education.degree', label: '最高学历', category: 'education', required: true, source: education?.degree }),
    field({ id: 'education.institution', label: '毕业院校', category: 'education', required: true, source: education?.institution }),
    field({ id: 'education.major', label: '专业', category: 'education', required: true, source: education?.major_name }),
    field({ id: 'education.cohort', label: '毕业届别', category: 'education', required: true, source: education?.cohort }),
    field({ id: 'experience.summary', label: '实习、项目与校园经历', category: 'experience', source: experience.source, maxLength: 2000, draft: experience.draft }),
    field({ id: 'motivation.application', label: '应聘动机', category: 'motivation', required: true, maxLength: 500 }),
    field({ id: 'motivation.self_evaluation', label: '自我评价', category: 'motivation', maxLength: 500 }),
    field({ id: 'preferences.locations', label: '意向工作地点', category: 'preferences', source: location }),
    field({ id: 'preferences.adjustment', label: '是否接受调剂', category: 'preferences', source: profile.schema_version === 2 ? structuredField(profile, 'preferences.adjustment') : null }),
  ];
  const experienceField = fields.find((item) => item.id === 'experience.summary');
  experienceField.source_fact_ids = experience.fact_ids;
  return fields;
}

function buildMaterials(profile) {
  const material = (id, label, facts, restricted = false) => {
    const evidenceIds = [...new Set(facts.flatMap((item) => item.evidence_ids || []))];
    const ready = !restricted && facts.length > 0 && evidenceIds.length > 0;
    return {
      id, label,
      status: restricted ? 'manual_required' : ready ? 'ready' : 'missing',
      evidence_ids: restricted ? [] : evidenceIds,
      manual_required: restricted,
    };
  };
  return [
    material('transcript', '成绩单', profile.facts.filter((item) => ['grade', 'ranking'].includes(item.type) && item.status === 'confirmed')),
    material('language_certificates', '英语等级证明', profile.facts.filter((item) => item.type === 'certificate' && item.status === 'confirmed')),
    material('awards', '获奖证明', profile.facts.filter((item) => item.type === 'award' && item.status === 'confirmed')),
    material('identity_document', '身份证件', [], true),
    material('family_information', '家庭成员信息', [], true),
  ];
}

export function validateApplication(application) {
  const errors = [];
  if (!validateSchema(application)) errors.push(...(validateSchema.errors || []).map((item) => ({ code: 'schema_invalid', path: item.instancePath || '/', message: item.message })));
  const ids = new Set();
  for (const item of application?.fields || []) {
    if (ids.has(item.id)) errors.push({ code: 'duplicate_field_id', id: item.id });
    ids.add(item.id);
    if (RESTRICTED_FIELD_IDS.has(item.id)) {
      if ('draft' in item) errors.push({ code: 'restricted_value_persisted', id: item.id });
      if (!item.manual_required || item.source_fact_ids.length) errors.push({ code: 'restricted_field_not_manual', id: item.id });
    }
    if (item.max_length && typeof item.draft === 'string' && [...item.draft].length > item.max_length) {
      errors.push({ code: 'field_length_exceeded', id: item.id, maximum: item.max_length });
    }
  }
  const canonical = CN_STAGE_TO_CANONICAL[application?.current_stage];
  if (canonical && canonical !== application.canonical_status) errors.push({ code: 'stage_status_mismatch' });
  return { valid: errors.length === 0, errors };
}

export async function prepareApplication(root, jobId, options = {}) {
  const { posting, report } = loadJobEvaluation(root, jobId);
  const profile = loadCandidateProfile(root);
  const trackerNum = options.tracker_num || await createTrackerEntry(root, posting, report);
  const existingPath = join(root, 'data', 'careerpilot', 'applications', `${trackerNum}.json`);
  if (existsSync(existingPath)) {
    const existing = loadApplication(root, trackerNum);
    if (existing.job_id !== jobId) throw new Error(`Tracker #${trackerNum} is already linked to a different CareerPilot CN job`);
    return { application: existing, path: existingPath };
  }
  const now = new Date().toISOString();
  const application = {
    schema_version: 1,
    id: `application.${trackerNum}`,
    job_id: jobId,
    tracker_num: trackerNum,
    created_at: now,
    updated_at: now,
    current_stage: report.eligibility.result === 'ineligible' && !report.override ? 'ineligible' : 'evaluated',
    canonical_status: report.eligibility.result === 'ineligible' && !report.override ? 'SKIP' : 'Evaluated',
    deadline: posting.recruitment.deadline || null,
    fields: buildFields(profile),
    materials: buildMaterials(profile),
    events: [{
      stage: report.eligibility.result === 'ineligible' && !report.override ? 'ineligible' : 'evaluated',
      canonical_status: report.eligibility.result === 'ineligible' && !report.override ? 'SKIP' : 'Evaluated',
      recorded_at: now,
      note: 'CareerPilot CN 网申材料已建立',
    }],
  };
  const validation = validateApplication(application);
  if (!validation.valid) {
    const error = new Error('Application validation failed');
    error.code = 'APPLICATION_INVALID';
    error.details = validation.errors;
    throw error;
  }
  const path = existingPath;
  atomicWrite(path, `${JSON.stringify(application, null, 2)}\n`);
  return { application, path };
}

export function loadApplication(root, trackerNum) {
  if (!Number.isSafeInteger(Number(trackerNum)) || Number(trackerNum) < 1) throw new Error('Invalid tracker number');
  const path = join(root, 'data', 'careerpilot', 'applications', `${Number(trackerNum)}.json`);
  if (!existsSync(path)) throw new Error(`CareerPilot CN application not found: ${trackerNum}`);
  const application = JSON.parse(readFileSync(path, 'utf8'));
  const validation = validateApplication(application);
  if (!validation.valid) throw new Error(`Stored CareerPilot CN application is invalid: ${trackerNum}`);
  return application;
}

export function listApplications(root) {
  const directory = join(root, 'data', 'careerpilot', 'applications');
  if (!existsSync(directory)) return [];
  const applications = [];
  for (const name of readdirSync(directory)) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const application = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      if (validateApplication(application).valid) applications.push(application);
    } catch { /* skip invalid sidecars; reconciliation surfaces them separately */ }
  }
  return applications.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

export function updateApplicationFields(root, trackerNum, updates) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw new Error('Application field updates must be an object');
  const application = structuredClone(loadApplication(root, trackerNum));
  const byId = new Map(application.fields.map((item) => [item.id, item]));
  for (const [id, value] of Object.entries(updates)) {
    const item = byId.get(id);
    if (!item) throw new Error(`Unknown application field: ${id}`);
    if (item.sensitivity === 'restricted' || RESTRICTED_FIELD_IDS.has(id)) {
      const error = new Error(`Restricted application field must be filled manually: ${id}`);
      error.code = 'RESTRICTED_FIELD';
      throw error;
    }
    item.draft = typeof value === 'string' ? cleanText(value) : value;
    item.manual_required = false;
  }
  application.updated_at = new Date().toISOString();
  const validation = validateApplication(application);
  if (!validation.valid) {
    const error = new Error('Application field update is invalid');
    error.code = 'APPLICATION_INVALID';
    error.details = validation.errors;
    throw error;
  }
  const path = join(root, 'data', 'careerpilot', 'applications', `${Number(trackerNum)}.json`);
  atomicWrite(path, `${JSON.stringify(application, null, 2)}\n`);
  return application;
}

function trackerStatus(root, trackerNum) {
  return trackerRows(root).find((row) => row.num === Number(trackerNum))?.status || null;
}

export function reconcileApplication(root, trackerNum) {
  const application = loadApplication(root, trackerNum);
  const actual = trackerStatus(root, trackerNum);
  return {
    consistent: actual === application.canonical_status,
    tracker_status: actual,
    sidecar_status: application.canonical_status,
    stage: application.current_stage,
  };
}

export function updateApplicationStage(root, trackerNum, stage, options = {}) {
  const canonical = CN_STAGE_TO_CANONICAL[stage];
  if (!canonical) throw new Error(`Unknown CareerPilot CN application stage: ${stage}`);
  const application = loadApplication(root, trackerNum);
  const now = new Date().toISOString();
  const note = cleanText(options.note || `cn-stage:${stage}`);
  const next = structuredClone(application);
  next.current_stage = stage;
  next.canonical_status = canonical;
  next.updated_at = now;
  next.events.push({ stage, canonical_status: canonical, recorded_at: now, note });
  const validation = validateApplication(next);
  if (!validation.valid) {
    const error = new Error('Application stage update is invalid');
    error.code = 'APPLICATION_INVALID';
    error.details = validation.errors;
    throw error;
  }
  const path = join(root, 'data', 'careerpilot', 'applications', `${Number(trackerNum)}.json`);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  try {
    execFileSync(process.execPath, [join(ROOT, 'set-status.mjs'), String(trackerNum), canonical, '--note', note, '--json'], {
      cwd: ROOT,
      env: { ...process.env, CAREER_OPS_TRACKER: ensureTracker(root) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error(`Unable to synchronize application stage with tracker: ${error.stderr?.toString() || error.message}`);
  }
  return { application: next, reconciliation: reconcileApplication(root, trackerNum) };
}
