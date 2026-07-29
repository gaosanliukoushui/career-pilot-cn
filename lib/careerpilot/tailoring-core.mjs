import Ajv2020 from 'ajv/dist/2020.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJobEvaluation } from './job-core.mjs';
import { loadCandidateProfile } from './profile-core.mjs';
import { createResumeVariant, exportResume, validateResumeVariant } from './resume-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'cn', 'resume-tailoring.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);
export const MAXIMUM_TAILORING_RATIO = 0.30;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, 'utf8');
  renameSync(temporary, path);
}

export function loadResumeVariant(root, variantId) {
  if (!/^[a-z0-9][a-z0-9._-]+$/.test(variantId)) throw new Error('Invalid ResumeVariant ID');
  const path = join(root, 'profile', 'variants', `${variantId}.json`);
  if (!existsSync(path)) throw new Error(`ResumeVariant not found: ${variantId}`);
  const variant = JSON.parse(readFileSync(path, 'utf8'));
  const validation = validateResumeVariant(root, variant);
  if (!validation.valid) {
    const error = new Error('Stored ResumeVariant is invalid or stale');
    error.code = 'RESUME_VARIANT_INVALID';
    error.details = validation.errors;
    throw error;
  }
  return variant;
}

export function listResumeVariants(root, { approvedOnly = false } = {}) {
  const directory = join(root, 'profile', 'variants');
  if (!existsSync(directory)) return [];
  const variants = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.json') || name.startsWith('tailoring.')) continue;
    try {
      const variant = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      const validation = validateResumeVariant(root, variant);
      if (!validation.valid || (approvedOnly && !['ready', 'exported'].includes(variant.status))) continue;
      variants.push({ id: variant.id, template: variant.template, status: variant.status, fact_count: variant.fact_ids.length });
    } catch { /* ignore corrupt or stale variants in discovery */ }
  }
  return variants.sort((left, right) => left.id.localeCompare(right.id));
}

export function resumeVariantContext(root, variantId) {
  const variant = loadResumeVariant(root, variantId);
  const profile = loadCandidateProfile(root);
  const byId = new Map(profile.facts.map((fact) => [fact.id, fact]));
  return {
    variant,
    facts: variant.order.map((id) => byId.get(id)).filter(Boolean).map((fact) => ({ id: fact.id, type: fact.type, statement: fact.statement })),
  };
}

function relativeOrderChanges(baselineOrder, proposedOrder) {
  const proposedIndex = new Map(proposedOrder.map((id, index) => [id, index]));
  const common = baselineOrder.filter((id) => proposedIndex.has(id));
  const changed = new Set();
  for (let left = 0; left < common.length; left += 1) {
    for (let right = left + 1; right < common.length; right += 1) {
      if (proposedIndex.get(common[left]) > proposedIndex.get(common[right])) {
        changed.add(common[left]);
        changed.add(common[right]);
      }
    }
  }
  return changed;
}

export function computeTailoringChange(baseline, proposed) {
  const baselineIds = new Set(baseline.fact_ids);
  const proposedIds = new Set(proposed.fact_ids);
  const changed = new Set();
  for (const id of baselineIds) if (!proposedIds.has(id)) changed.add(id);
  for (const id of proposedIds) if (!baselineIds.has(id)) changed.add(id);
  for (const rewrite of proposed.rewrites || []) if (rewrite.accepted) changed.add(rewrite.fact_id);
  for (const id of relativeOrderChanges(baseline.order, proposed.order)) changed.add(id);
  const changedFactIds = [...changed].sort();
  const ratio = Math.round((changedFactIds.length / baselineIds.size) * 10_000) / 10_000;
  return { changed_fact_ids: changedFactIds, change_ratio: ratio };
}

function eligibilityAllowsTailoring(report) {
  return report.eligibility.result === 'eligible' || Boolean(report.override);
}

export function createTailoringPreview(root, jobId, options = {}) {
  const { report } = loadJobEvaluation(root, jobId);
  const baseline = options.baseline_variant || loadResumeVariant(root, options.baseline_variant_id);
  if (!['ready', 'exported'].includes(baseline.status)) {
    const error = new Error('Job tailoring requires an approved master ResumeVariant');
    error.code = 'BASELINE_NOT_APPROVED';
    throw error;
  }
  const baselineValidation = validateResumeVariant(root, baseline);
  if (!baselineValidation.valid) throw new Error('Approved baseline ResumeVariant is invalid or stale');
  const proposed = createResumeVariant(root, {
    id: options.id || `resume.job.${jobId.slice(4)}.${randomUUID()}`,
    template: baseline.template,
    fact_ids: options.fact_ids || baseline.fact_ids,
    order: options.order || baseline.order,
    rewrites: options.rewrites || [],
    sensitive_authorizations: options.sensitive_authorizations || baseline.sensitive_authorizations,
    status: 'draft',
  });
  const change = computeTailoringChange(baseline, proposed);
  const blockReasons = [];
  if (change.change_ratio > MAXIMUM_TAILORING_RATIO) blockReasons.push('tailoring_limit_exceeded');
  if (!eligibilityAllowsTailoring(report)) blockReasons.push('eligibility_blocked');
  const preview = {
    schema_version: 1,
    id: `tailoring.${sha256(`${jobId}|${baseline.id}|${stableJson(proposed)}`).slice(0, 24)}`,
    job_id: jobId,
    source_job_sha256: report.job_sha256,
    source_profile_sha256: proposed.source_profile_sha256,
    baseline_variant_id: baseline.id,
    baseline_variant_sha256: sha256(stableJson(baseline)),
    baseline_fact_count: new Set(baseline.fact_ids).size,
    ...change,
    maximum_change_ratio: MAXIMUM_TAILORING_RATIO,
    allowed: blockReasons.length === 0,
    block_reasons: blockReasons,
    proposed_variant: proposed,
  };
  const validation = validateTailoringPreview(root, preview, baseline);
  if (!validation.valid) {
    const error = new Error('Resume tailoring preview validation failed');
    error.code = 'TAILORING_PREVIEW_INVALID';
    error.details = validation.errors;
    throw error;
  }
  return preview;
}

export function validateTailoringPreview(root, preview, suppliedBaseline = null) {
  const errors = [];
  if (!validateSchema(preview)) {
    errors.push(...(validateSchema.errors || []).map((item) => ({ code: 'schema_invalid', path: item.instancePath || '/', message: item.message })));
  }
  let evaluation;
  let baseline = suppliedBaseline;
  try {
    evaluation = loadJobEvaluation(root, preview.job_id);
    baseline ||= loadResumeVariant(root, preview.baseline_variant_id);
  } catch (error) {
    errors.push({ code: 'source_missing_or_invalid', message: error.message });
    return { valid: false, errors };
  }
  if (evaluation.report.job_sha256 !== preview.source_job_sha256) errors.push({ code: 'job_changed_since_preview' });
  if (sha256(stableJson(baseline)) !== preview.baseline_variant_sha256) errors.push({ code: 'baseline_changed_since_preview' });
  if (preview.proposed_variant?.source_profile_sha256 !== preview.source_profile_sha256) errors.push({ code: 'profile_hash_mismatch' });
  const variantValidation = validateResumeVariant(root, preview.proposed_variant);
  if (!variantValidation.valid) errors.push(...variantValidation.errors);
  const expected = computeTailoringChange(baseline, preview.proposed_variant);
  if (stableJson(expected.changed_fact_ids) !== stableJson(preview.changed_fact_ids) || expected.change_ratio !== preview.change_ratio) {
    errors.push({ code: 'tailoring_diff_mismatch' });
  }
  const expectedReasons = [];
  if (expected.change_ratio > MAXIMUM_TAILORING_RATIO) expectedReasons.push('tailoring_limit_exceeded');
  if (!eligibilityAllowsTailoring(evaluation.report)) expectedReasons.push('eligibility_blocked');
  if (stableJson(expectedReasons) !== stableJson(preview.block_reasons) || preview.allowed !== (expectedReasons.length === 0)) {
    errors.push({ code: 'tailoring_gate_mismatch' });
  }
  return { valid: errors.length === 0, errors };
}

export function saveTailoringPreview(root, preview) {
  const validation = validateTailoringPreview(root, preview);
  if (!validation.valid) {
    const error = new Error('Cannot save invalid ResumeTailoringPreview');
    error.code = 'TAILORING_PREVIEW_INVALID';
    error.details = validation.errors;
    throw error;
  }
  const path = join(root, 'profile', 'variants', `${preview.id}.json`);
  atomicWrite(path, `${JSON.stringify(preview, null, 2)}\n`);
  return path;
}

export async function exportTailoredResume(root, preview, format, requestedPath) {
  const validation = validateTailoringPreview(root, preview);
  if (!validation.valid) {
    const error = new Error('Resume tailoring preview is invalid or stale');
    error.code = 'TAILORING_PREVIEW_INVALID';
    error.details = validation.errors;
    throw error;
  }
  if (!preview.allowed) {
    const error = new Error('Resume tailoring is blocked');
    error.code = 'TAILORING_BLOCKED';
    error.details = preview.block_reasons;
    throw error;
  }
  return exportResume(root, preview.proposed_variant, format, requestedPath, {
    manifestExtra: {
      job_id: preview.job_id,
      tailoring_preview_id: preview.id,
      baseline_variant_id: preview.baseline_variant_id,
      changed_fact_ids: preview.changed_fact_ids,
      change_ratio: preview.change_ratio,
      maximum_change_ratio: preview.maximum_change_ratio,
    },
  });
}
