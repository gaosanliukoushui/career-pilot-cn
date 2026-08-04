import Ajv2020 from 'ajv/dist/2020.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJobEvaluation } from './job-core.mjs';
import { loadCandidateProfile } from './profile-core.mjs';
import { loadTrustedResumeArtifact } from './artifact-core.mjs';
import { formatReportNumber, releaseReportNumbers, reserveReportNumbers } from '../../reserve-report-num.mjs';
import { parseTrackerRow, resolveColumns } from '../../tracker-parse.mjs';
import { applyCanonicalTrackerStatusChange, openTrackerTransaction } from '../../tracker-utils.mjs';

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

function field({
  id, label, category, sensitivity = 'personal', required = false, source = null, sourceFactIds = [],
  maxLength = null, draft, definitionSource = 'default', sourceQuote = '',
}) {
  const restricted = RESTRICTED_FIELD_IDS.has(id) || sensitivity === 'restricted';
  const factIds = [...new Set([...(source?.fact_id ? [source.fact_id] : []), ...sourceFactIds])];
  const result = {
    id, label, category, required, sensitivity,
    manual_required: restricted || !source,
    source_fact_ids: restricted ? [] : factIds,
    max_length: maxLength,
    definition_source: definitionSource,
    source_quote: cleanText(sourceQuote),
    confirmation_status: restricted ? 'manual_required' : 'pending',
  };
  if (!restricted && draft !== undefined) { result.draft = draft; result.manual_required = false; }
  else if (!restricted && source?.value !== undefined) result.draft = source.value;
  return result;
}

function rankedApplicationFacts(profile, report) {
  const allowed = profile.facts.filter((item) => item.status === 'confirmed'
    && item.allowed_uses.includes('application_form') && !['sensitive', 'restricted'].includes(item.sensitivity));
  const relevance = new Map();
  for (const dimension of [...(report.fit?.dimensions || [])].sort((left, right) => right.score - left.score)) {
    for (const factId of dimension.candidate_fact_ids || []) if (!relevance.has(factId)) relevance.set(factId, relevance.size);
  }
  return [...allowed].sort((left, right) => (relevance.get(left.id) ?? 999) - (relevance.get(right.id) ?? 999));
}

function experienceDraft(profile, report) {
  const facts = rankedApplicationFacts(profile, report).filter((item) => ['internship', 'project', 'campus', 'employment'].includes(item.type));
  return {
    source: facts.length ? { fact_id: facts[0].id } : null,
    fact_ids: facts.map((item) => item.id),
    draft: facts.map((item) => item.statement).join('\n'),
  };
}

function candidateDraft(label, posting, facts, maxLength) {
  if (!facts.length) return '';
  const text = `${label}：申请${posting.title}，可引用的已确认经历包括：${facts.slice(0, 4).map((item) => item.statement).join('；')}。`;
  return maxLength ? [...text].slice(0, maxLength).join('') : text;
}

function buildFields(profile, posting, report, options = {}) {
  const education = profile.schema_version === 2 ? profile.structured.education : {};
  const rankedFacts = rankedApplicationFacts(profile, report);
  const experience = experienceDraft(profile, report);
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
    field({ id: 'experience.summary', label: '实习、项目与校园经历', category: 'experience', source: experience.source, sourceFactIds: experience.fact_ids, maxLength: 2000, draft: experience.draft }),
    field({ id: 'motivation.application', label: '应聘动机', category: 'motivation', required: true, sourceFactIds: rankedFacts.slice(0, 3).map((item) => item.id), maxLength: 500, draft: candidateDraft('应聘动机候选草稿', posting, rankedFacts, 500) }),
    field({ id: 'motivation.self_evaluation', label: '自我评价', category: 'motivation', sourceFactIds: rankedFacts.slice(0, 3).map((item) => item.id), maxLength: 500, draft: candidateDraft('自我评价候选草稿', posting, rankedFacts, 500) }),
    field({ id: 'preferences.locations', label: '意向工作地点', category: 'preferences', source: location }),
    field({ id: 'preferences.adjustment', label: '是否接受调剂', category: 'preferences', source: profile.schema_version === 2 ? structuredField(profile, 'preferences.adjustment') : null }),
  ];
  const byId = new Map(fields.map((item) => [item.id, item]));
  for (const definition of options.form_fields || []) {
    if (!definition || typeof definition.id !== 'string' || !/^[a-z][a-z0-9._-]+$/.test(definition.id)) throw new Error('Invalid application form field definition');
    const sensitivity = definition.sensitivity || 'personal';
    const allowedIds = new Set(rankedFacts.map((item) => item.id));
    const sourceFacts = Array.isArray(definition.source_fact_ids)
      ? definition.source_fact_ids.filter((id) => allowedIds.has(id)).map((id) => rankedFacts.find((item) => item.id === id)).filter(Boolean)
      : rankedFacts.slice(0, 4);
    const maxLength = Number.isSafeInteger(definition.max_length) && definition.max_length > 0 ? definition.max_length : null;
    const custom = field({
      id: definition.id,
      label: cleanText(definition.label || definition.id),
      category: definition.category || 'materials',
      required: definition.required === true,
      sensitivity,
      sourceFactIds: sourceFacts.map((item) => item.id),
      maxLength,
      draft: sensitivity === 'restricted' ? undefined : candidateDraft(definition.label || definition.id, posting, sourceFacts, maxLength),
      definitionSource: 'application_form',
      sourceQuote: definition.source_quote || '',
    });
    byId.set(custom.id, custom);
  }
  const merged = [...byId.values()];
  return merged;
}

function buildMaterials(profile, definitions = []) {
  const material = (id, label, facts, restricted = false, required = false, definitionSource = 'default', sourceQuote = '') => {
    const evidenceIds = [...new Set(facts.flatMap((item) => item.evidence_ids || []))];
    const ready = !restricted && facts.length > 0 && evidenceIds.length > 0;
    return {
      id, label, required,
      status: restricted ? 'manual_required' : ready ? 'ready' : 'missing',
      evidence_ids: restricted ? [] : evidenceIds,
      manual_required: restricted,
      definition_source: definitionSource,
      source_quote: cleanText(sourceQuote),
    };
  };
  const defaults = [
    material('transcript', '成绩单', profile.facts.filter((item) => ['grade', 'ranking'].includes(item.type) && item.status === 'confirmed')),
    material('language_certificates', '英语等级证明', profile.facts.filter((item) => item.type === 'certificate' && item.status === 'confirmed')),
    material('awards', '获奖证明', profile.facts.filter((item) => item.type === 'award' && item.status === 'confirmed')),
    material('identity_document', '身份证件', [], true),
    material('family_information', '家庭成员信息', [], true),
  ];
  const byId = new Map(defaults.map((item) => [item.id, item]));
  const factsById = new Map(profile.facts.map((item) => [item.id, item]));
  for (const definition of definitions) {
    if (!definition || typeof definition.id !== 'string') throw new Error('Invalid job material definition');
    const facts = (definition.source_fact_ids || []).map((id) => factsById.get(id)).filter((item) => item?.status === 'confirmed');
    byId.set(definition.id, material(
      definition.id, cleanText(definition.label || definition.id), facts,
      definition.sensitivity === 'restricted', definition.required === true, 'job_posting', definition.source_quote || '',
    ));
  }
  return [...byId.values()];
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
  if (Boolean(application?.campaign_id) !== Boolean(application?.resume_artifact)) errors.push({ code: 'campaign_resume_binding_incomplete' });
  if (application?.campaign_id && !Array.isArray(application?.pre_submission_checklist)) errors.push({ code: 'campaign_checklist_missing' });
  return { valid: errors.length === 0, errors };
}

function buildPreSubmissionChecklist(posting, materials, trustedArtifact) {
  const missingRequired = materials.some((item) => item.required && item.status !== 'ready' && item.status !== 'manual_required');
  const officialUrl = posting.source.final_url || posting.source.ref || null;
  return [
    { id: 'final_resume', label: '已绑定通过 QA 的最终 DOCX/PDF 简历及 manifest', status: trustedArtifact ? 'ready' : 'missing' },
    { id: 'required_materials', label: '必备材料已齐全', status: missingRequired ? 'missing' : 'ready' },
    { id: 'manual_sensitive_fields', label: '身份证、家庭成员和详细住址仅在官网手工填写', status: 'manual_required' },
    { id: 'deadline_review', label: '已核对招聘截止日期', status: posting.recruitment.deadline ? 'ready' : 'missing' },
    { id: 'official_url', label: '已核对官方申请入口', status: officialUrl ? 'ready' : 'missing' },
    { id: 'external_submit', label: '由本人在外部官网检查并最终提交', status: 'manual_required' },
  ];
}

export async function prepareApplication(root, jobId, options = {}) {
  const { posting, report } = loadJobEvaluation(root, jobId);
  let trustedArtifact = null;
  if (options.campaign_id) {
    if (!options.resume_manifest) {
      const error = new Error('Campaign application preparation requires a trusted final resume manifest');
      error.code = 'CAMPAIGN_RESUME_REQUIRED';
      throw error;
    }
    trustedArtifact = loadTrustedResumeArtifact(root, options.resume_manifest, { campaign_id: options.campaign_id, job_id: jobId });
  }
  const profile = loadCandidateProfile(root);
  const trackerNum = options.tracker_num || await createTrackerEntry(root, posting, report);
  const existingPath = join(root, 'data', 'careerpilot', 'applications', `${trackerNum}.json`);
  if (existsSync(existingPath)) {
    const hasFieldDefinitions = Object.hasOwn(options, 'form_fields');
    const hasMaterialDefinitions = Object.hasOwn(options, 'materials');
    if (!hasFieldDefinitions && !hasMaterialDefinitions && !trustedArtifact) {
      const existing = loadApplication(root, trackerNum);
      if (existing.job_id !== jobId) throw new Error(`Tracker #${trackerNum} is already linked to a different CareerPilot CN job`);
      return { application: existing, path: existingPath };
    }
    const transaction = await openTrackerTransaction(ensureTracker(root));
    try {
      const snapshot = trackerRowFromContent(transaction.read(), trackerNum);
      const existing = structuredClone(loadApplication(root, trackerNum));
      if (existing.job_id !== jobId) throw new Error(`Tracker #${trackerNum} is already linked to a different CareerPilot CN job`);
      assertApplicationConsistency(existing, snapshot.row);
      if (trustedArtifact) {
        const nextArtifact = {
          manifest: relative(root, trustedArtifact.manifest_path).replaceAll('\\', '/'),
          output: relative(root, trustedArtifact.output_path).replaceAll('\\', '/'),
          content_sha256: trustedArtifact.manifest.content_sha256,
        };
        if (existing.campaign_id && (existing.campaign_id !== options.campaign_id || existing.resume_artifact.content_sha256 !== nextArtifact.content_sha256)) {
          const error = new Error('Application Campaign and final resume binding is immutable');
          error.code = 'APPLICATION_ARTIFACT_IMMUTABLE';
          throw error;
        }
        existing.campaign_id = options.campaign_id;
        existing.resume_artifact = nextArtifact;
      }
      if (hasFieldDefinitions) {
        const previous = new Map(existing.fields.map((item) => [item.id, item]));
        existing.fields = buildFields(profile, posting, report, options).map((item) => {
          const prior = previous.get(item.id);
          if (prior?.confirmation_status === 'confirmed' && 'draft' in prior && item.sensitivity !== 'restricted') {
            return { ...item, draft: prior.draft, manual_required: false, confirmation_status: 'confirmed' };
          }
          return item;
        });
      }
      if (hasMaterialDefinitions) existing.materials = buildMaterials(profile, options.materials || []);
      if (existing.campaign_id) {
        existing.official_url = posting.source.final_url || posting.source.ref || null;
        existing.pre_submission_checklist = buildPreSubmissionChecklist(posting, existing.materials, existing.resume_artifact || null);
      }
      existing.updated_at = new Date().toISOString();
      const validation = validateApplication(existing);
      if (!validation.valid) {
        const error = new Error('Updated application definitions are invalid');
        error.code = 'APPLICATION_INVALID';
        error.details = validation.errors;
        throw error;
      }
      atomicWrite(existingPath, `${JSON.stringify(existing, null, 2)}\n`);
      return { application: existing, path: existingPath };
    } finally {
      transaction.close();
    }
  }
  const now = new Date().toISOString();
  const materials = buildMaterials(profile, options.materials || []);
  const application = {
    schema_version: 1,
    id: `application.${trackerNum}`,
    job_id: jobId,
    ...(trustedArtifact ? {
      campaign_id: options.campaign_id,
      resume_artifact: {
        manifest: relative(root, trustedArtifact.manifest_path).replaceAll('\\', '/'),
        output: relative(root, trustedArtifact.output_path).replaceAll('\\', '/'),
        content_sha256: trustedArtifact.manifest.content_sha256,
      },
    } : {}),
    tracker_num: trackerNum,
    created_at: now,
    updated_at: now,
    current_stage: report.eligibility.result === 'ineligible' && !report.override ? 'ineligible' : 'evaluated',
    canonical_status: report.eligibility.result === 'ineligible' && !report.override ? 'SKIP' : 'Evaluated',
    deadline: posting.recruitment.deadline || null,
    official_url: posting.source.final_url || posting.source.ref || null,
    fields: buildFields(profile, posting, report, options),
    materials,
    pre_submission_checklist: buildPreSubmissionChecklist(posting, materials, trustedArtifact),
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

function trackerRowFromContent(content, trackerNum) {
  const lines = content.split('\n');
  const columns = resolveColumns(lines);
  const matches = lines.map((line, lineIndex) => {
    const row = parseTrackerRow(line, columns);
    return row ? { ...row, lineIndex } : null;
  }).filter((row) => row?.num === Number(trackerNum));
  if (matches.length !== 1) {
    const error = new Error(matches.length ? `Tracker #${trackerNum} is ambiguous` : `Tracker #${trackerNum} was not found`);
    error.code = matches.length ? 'APPLICATION_TRACKER_AMBIGUOUS' : 'APPLICATION_TRACKER_MISSING';
    throw error;
  }
  return { lines, columns, row: matches[0] };
}

function assertApplicationConsistency(application, trackerRow) {
  if (trackerRow.status !== application.canonical_status) {
    const error = new Error(`Application status conflict: tracker=${trackerRow.status}, sidecar=${application.canonical_status}`);
    error.code = 'APPLICATION_STATUS_CONFLICT';
    error.details = {
      tracker_status: trackerRow.status,
      sidecar_status: application.canonical_status,
      stage: application.current_stage,
    };
    throw error;
  }
}

export async function updateApplicationFields(root, trackerNum, updates) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw new Error('Application field updates must be an object');
  const transaction = await openTrackerTransaction(ensureTracker(root));
  try {
    const snapshot = trackerRowFromContent(transaction.read(), trackerNum);
    const application = structuredClone(loadApplication(root, trackerNum));
    assertApplicationConsistency(application, snapshot.row);
    const byId = new Map(application.fields.map((item) => [item.id, item]));
    for (const [id, value] of Object.entries(updates)) {
      const item = byId.get(id);
      if (!item) throw new Error(`Unknown application field: ${id}`);
      if (item.sensitivity === 'restricted' || RESTRICTED_FIELD_IDS.has(id)) {
        const error = new Error(`Restricted application field must be filled manually: ${id}`);
        error.code = 'RESTRICTED_FIELD';
        throw error;
      }
      const supplied = value && typeof value === 'object' && !Array.isArray(value) && 'draft' in value ? value.draft : value;
      item.draft = typeof supplied === 'string' ? cleanText(supplied) : supplied;
      item.manual_required = false;
      item.confirmation_status = 'confirmed';
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
  } finally {
    transaction.close();
  }
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

export async function updateApplicationStage(root, trackerNum, stage, options = {}) {
  const canonical = CN_STAGE_TO_CANONICAL[stage];
  if (!canonical) throw new Error(`Unknown CareerPilot CN application stage: ${stage}`);
  if (stage === 'submitted' && options.external_submission_confirmed !== true) {
    const error = new Error('Confirm that the application was submitted on the external official website before marking it Applied');
    error.code = 'EXTERNAL_SUBMISSION_CONFIRMATION_REQUIRED';
    throw error;
  }
  const transaction = await openTrackerTransaction(ensureTracker(root));
  try {
    const trackerContent = transaction.read();
    const snapshot = trackerRowFromContent(trackerContent, trackerNum);
    const application = loadApplication(root, trackerNum);
    assertApplicationConsistency(application, snapshot.row);
    const now = new Date().toISOString();
    const note = cleanText(options.note || `cn-stage:${stage}`);
    const lastEvent = application.events.at(-1);
    if (application.current_stage === stage && lastEvent?.note === note) {
      return { application, reconciliation: { consistent: true, tracker_status: snapshot.row.status, sidecar_status: application.canonical_status, stage } };
    }
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

    applyCanonicalTrackerStatusChange({
      lines: snapshot.lines,
      lineIndex: snapshot.row.lineIndex,
      columns: snapshot.columns,
      requestedStatus: canonical,
      rawNote: note,
      statesPath: join(ROOT, 'templates', 'states.yml'),
      expectedTrackerNum: trackerNum,
      expectedReportPath: loadJobEvaluation(root, application.job_id).report.report_path,
      enforceReportIdentity: true,
    });
    const nextTrackerContent = snapshot.lines.join('\n');
    const path = join(root, 'data', 'careerpilot', 'applications', `${Number(trackerNum)}.json`);
    transaction.replace(nextTrackerContent);
    try {
      atomicWrite(path, `${JSON.stringify(next, null, 2)}\n`);
    } catch (error) {
      transaction.replace(trackerContent);
      throw error;
    }
    return {
      application: next,
      reconciliation: { consistent: true, tracker_status: canonical, sidecar_status: canonical, stage },
    };
  } finally {
    transaction.close();
  }
}
