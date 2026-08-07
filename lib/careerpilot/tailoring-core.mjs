import Ajv2020 from 'ajv/dist/2020.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJobEvaluation } from './job-core.mjs';
import { loadCandidateProfile } from './profile-core.mjs';
import { confirmResumeVariant, createResumeVariant, exportResume, validateResumeVariant } from './resume-core.mjs';
import { sha256, stableJson } from './hash-core.mjs';
import { assertCampaignSelectionCurrent } from './campaign-core.mjs';
import { verifyRenderedResumeDocx, verifyRenderedResumePdf } from './artifact-qa-core.mjs';
import { loadResumeStyle, resolveResumeContentStrategy } from './resume-style-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'cn', 'resume-tailoring.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);
export const MAXIMUM_TAILORING_RATIO = 0.30;

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, 'utf8');
  renameSync(temporary, path);
}

function readStoredResumeVariant(root, variantId) {
  if (!/^[a-z0-9][a-z0-9._-]+$/.test(variantId)) throw new Error('Invalid ResumeVariant ID');
  const path = join(root, 'profile', 'variants', `${variantId}.json`);
  if (!existsSync(path)) throw new Error(`ResumeVariant not found: ${variantId}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadResumeVariant(root, variantId) {
  const variant = readStoredResumeVariant(root, variantId);
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
      if (!validation.valid || (approvedOnly && (!['ready', 'exported'].includes(variant.status) || variant.id.startsWith('resume.job.')))) continue;
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

function jobOverlapScore(statement, rawText) {
  const normalized = String(rawText || '').toLowerCase();
  const tokens = String(statement).toLowerCase().match(/[a-z0-9]{2,}|[\p{Script=Han}]/gu) || [];
  return tokens.reduce((score, token) => score + (normalized.includes(token) ? 1 : 0), 0);
}

const TECHNOLOGY_TERM = /\b(?:java|spring(?:boot)?|mysql|redis|kafka|python|linux|docker|kubernetes|react|vue|sql|git|maven)\b|数据库|缓存|消息队列|微服务|框架/giu;
const PROBLEM_SIGNAL = /问题|需求|任务|目标|痛点|瓶颈|风险|异常|故障/u;
const OUTCOME_SIGNAL = /完成|交付|上线|验收|稳定运行|解决|降低|提升|减少|缩短|形成|闭环|通过|录用|授权|%|％|\d+\s*(?:人|项|个|倍|秒|毫秒|ms|万)/iu;
const EXPERIENCE_FACT_TYPES = new Set(['internship', 'employment', 'project', 'campus', 'affiliation']);
const OWNERSHIP_SIGNAL = /负责|承担|牵头|主导|独立|协调|组织/u;
const RESEARCH_METHOD_SIGNAL = /方法|实验|模型|数据集|调研|分析|设计|训练|评估/u;

function strategyClauseStage(strategyId, statement) {
  if (PROBLEM_SIGNAL.test(statement) || (strategyId === 'research-academic' && /研究|假设/u.test(statement))) return 0;
  if (strategyId === 'research-academic' && RESEARCH_METHOD_SIGNAL.test(statement)) return 1;
  if (OWNERSHIP_SIGNAL.test(statement)) return strategyId === 'research-academic' ? 2 : 1;
  if (OUTCOME_SIGNAL.test(statement)) return 3;
  return 2;
}

function auditFactForStrategy(fact, strategy) {
  const statement = String(fact.statement || '');
  const technologyTerms = statement.match(TECHNOLOGY_TERM) || [];
  const hasProblem = PROBLEM_SIGNAL.test(statement);
  const hasOutcome = OUTCOME_SIGNAL.test(statement);
  const issues = [];
  let guidance = '';
  if (technologyTerms.length >= 3 && !hasProblem && !hasOutcome) {
    if (strategy.id === 'soe-outcome') {
      issues.push('technology_stack_without_outcome');
      guidance = '不要直接堆技术栈；请补充并确认它解决的问题、个人责任和交付或结果 Evidence。';
    } else if (strategy.id === 'internet-engineering') {
      issues.push('technology_stack_without_engineering_context');
      guidance = '技术栈需要绑定技术或业务挑战、个人所有权、方案取舍以及性能、质量或业务影响。';
    } else {
      issues.push('method_stack_without_research_result');
      guidance = '方法和模型名称需要绑定研究问题、实验设计、个人贡献以及论文、专利、指标或转化结果。';
    }
  } else if (EXPERIENCE_FACT_TYPES.has(fact.type) && !hasOutcome) {
    issues.push('missing_result_evidence');
    guidance = `当前 Fact 尚未出现可验证结果。${strategy.outcome_definition} 系统不会代写，需先补充并确认 Evidence。`;
  }
  return {
    fact_id: fact.id,
    status: issues.length ? 'needs_evidence' : 'ready',
    issues,
    guidance,
  };
}

export function generateTailoringRewriteCandidates(root, jobId, baselineVariantId) {
  const { posting } = loadJobEvaluation(root, jobId);
  const baseline = loadResumeVariant(root, baselineVariantId);
  const profile = loadCandidateProfile(root);
  const byId = new Map(profile.facts.map((fact) => [fact.id, fact]));
  const strategy = resolveResumeContentStrategy(loadResumeStyle(root));
  const facts = baseline.order.map((factId) => byId.get(factId)).filter(Boolean);
  const factAudits = facts.map((fact) => auditFactForStrategy(fact, strategy));
  const candidates = [];
  for (const fact of facts) {
    const factId = fact.id;
    const clauses = fact.statement.split(/[；;。]+/u).map((item) => item.trim()).filter(Boolean);
    if (clauses.length < 2) continue;
    const ranked = clauses.map((statement, index) => ({
      statement,
      index,
      stage: strategyClauseStage(strategy.id, statement),
      score: jobOverlapScore(statement, posting.raw_text),
    })).sort((left, right) => left.stage - right.stage || right.score - left.score || left.index - right.index);
    const proposed = ranked.map((item) => item.statement).join('；');
    if (proposed === clauses.join('；') || ranked[0].score === ranked.at(-1).score) continue;
    candidates.push({
      fact_id: factId,
      original_statement: fact.statement,
      proposed_statement: proposed,
      status: 'pending',
      rationale: `${strategy.label}：仅重排原事实分句，并在同一表达阶段内将与岗位原文重叠更高的内容前置`,
    });
  }
  if (candidates.length) {
    createResumeVariant(root, {
      template: baseline.template,
      fact_ids: baseline.fact_ids,
      order: baseline.order,
      rewrites: candidates.map((item) => ({ fact_id: item.fact_id, proposed_statement: item.proposed_statement, accepted: true })),
    });
  }
  return {
    job_id: jobId,
    baseline_variant_id: baselineVariantId,
    strategy: {
      id: strategy.id,
      label: strategy.label,
      audience: strategy.audience,
      experience_formula: strategy.experience_formula,
      technology_rule: strategy.technology_rule,
      outcome_definition: strategy.outcome_definition,
      fact_audits: factAudits,
    },
    candidates,
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

function normalizeRewriteReviews(profile, options) {
  const byId = new Map(profile.facts.map((fact) => [fact.id, fact]));
  const supplied = options.rewrite_reviews || (options.rewrites || []).map((item) => ({
    fact_id: item.fact_id,
    proposed_statement: item.proposed_statement,
    status: item.accepted ? 'accepted' : 'pending',
  }));
  const reviews = supplied.map((item) => {
    const fact = byId.get(item.fact_id);
    if (!fact) throw new Error(`Unknown rewrite Fact: ${item.fact_id}`);
    return {
      fact_id: item.fact_id,
      original_statement: fact.statement,
      proposed_statement: String(item.proposed_statement || '').trim(),
      status: item.status,
    };
  });
  if (new Set(reviews.map((item) => item.fact_id)).size !== reviews.length) throw new Error('Duplicate rewrite review Fact');
  const candidates = reviews.filter((item) => item.status !== 'rejected');
  if (candidates.length) {
    createResumeVariant(options.root, {
      template: options.template,
      fact_ids: options.fact_ids,
      order: options.order,
      rewrites: candidates.map((item) => ({ fact_id: item.fact_id, proposed_statement: item.proposed_statement, accepted: true })),
    });
  }
  return reviews;
}

function buildTailoringChanges(profile, baseline, proposed, reviews) {
  const facts = new Map(profile.facts.map((fact) => [fact.id, fact]));
  const changes = [];
  for (const id of baseline.fact_ids) if (!proposed.fact_ids.includes(id)) changes.push({
    fact_id: id, type: 'removed', before: facts.get(id)?.statement || null, after: null, confirmation_status: 'confirmed',
  });
  for (const id of proposed.fact_ids) if (!baseline.fact_ids.includes(id)) changes.push({
    fact_id: id, type: 'added', before: null, after: facts.get(id)?.statement || null, confirmation_status: 'confirmed',
  });
  for (const review of reviews) changes.push({
    fact_id: review.fact_id,
    type: 'rewritten',
    before: review.original_statement,
    after: review.proposed_statement,
    confirmation_status: review.status === 'accepted' ? 'confirmed' : review.status,
  });
  const reordered = relativeOrderChanges(baseline.order, proposed.order);
  for (const id of reordered) changes.push({
    fact_id: id, type: 'reordered', before: String(baseline.order.indexOf(id) + 1), after: String(proposed.order.indexOf(id) + 1), confirmation_status: 'confirmed',
  });
  return changes;
}

function eligibilityAllowsTailoring(report) {
  return report.eligibility.result === 'eligible' || Boolean(report.override);
}

export function createTailoringPreview(root, jobId, options = {}) {
  const { posting, report } = loadJobEvaluation(root, jobId);
  const baseline = options.baseline_variant || loadResumeVariant(root, options.baseline_variant_id);
  if (!['ready', 'exported'].includes(baseline.status)) {
    const error = new Error('Job tailoring requires an approved master ResumeVariant');
    error.code = 'BASELINE_NOT_APPROVED';
    throw error;
  }
  const baselineValidation = validateResumeVariant(root, baseline);
  if (!baselineValidation.valid) throw new Error('Approved baseline ResumeVariant is invalid or stale');
  const profile = loadCandidateProfile(root);
  const factIds = options.fact_ids || baseline.fact_ids;
  const order = options.order || baseline.order;
  const reviews = normalizeRewriteReviews(profile, {
    ...options, root, template: baseline.template, fact_ids: factIds, order,
  });
  const acceptedRewrites = reviews.filter((item) => item.status === 'accepted').map((item) => ({
    fact_id: item.fact_id, proposed_statement: item.proposed_statement, accepted: true,
  }));
  const proposed = createResumeVariant(root, {
    id: options.id || `resume.job.${jobId.slice(4)}.${randomUUID()}`,
    template: baseline.template,
    target_job_title: posting.title,
    fact_ids: factIds,
    order,
    rewrites: acceptedRewrites,
    sensitive_authorizations: options.sensitive_authorizations || baseline.sensitive_authorizations,
    status: 'draft',
  });
  const change = computeTailoringChange(baseline, proposed);
  const blockReasons = [];
  if (change.change_ratio > MAXIMUM_TAILORING_RATIO) blockReasons.push('tailoring_limit_exceeded');
  if (!eligibilityAllowsTailoring(report)) blockReasons.push('eligibility_blocked');
  if (reviews.some((item) => item.status === 'pending')) blockReasons.push('rewrite_confirmation_pending');
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
    rewrite_reviews: reviews,
    changes: buildTailoringChanges(profile, baseline, proposed, reviews),
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
    baseline ||= readStoredResumeVariant(root, preview.baseline_variant_id);
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
  if (preview.rewrite_reviews?.some((item) => item.status === 'pending')) expectedReasons.push('rewrite_confirmation_pending');
  if (stableJson(expectedReasons) !== stableJson(preview.block_reasons) || preview.allowed !== (expectedReasons.length === 0)) {
    errors.push({ code: 'tailoring_gate_mismatch' });
  }
  const profile = loadCandidateProfile(root);
  const expectedChanges = buildTailoringChanges(profile, baseline, preview.proposed_variant, preview.rewrite_reviews || []);
  if (stableJson(expectedChanges) !== stableJson(preview.changes)) errors.push({ code: 'tailoring_changes_mismatch' });
  const accepted = (preview.rewrite_reviews || []).filter((item) => item.status === 'accepted')
    .map((item) => ({ fact_id: item.fact_id, proposed_statement: item.proposed_statement, accepted: true }));
  if (stableJson(accepted) !== stableJson(preview.proposed_variant?.rewrites || [])) errors.push({ code: 'rewrite_review_mismatch' });
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

export function loadTailoringPreview(root, previewId) {
  if (!/^tailoring\.[a-f0-9]{16,64}$/.test(previewId)) throw new Error('Invalid ResumeTailoringPreview ID');
  const path = join(root, 'profile', 'variants', `${previewId}.json`);
  if (!existsSync(path)) throw new Error(`ResumeTailoringPreview not found: ${previewId}`);
  const preview = JSON.parse(readFileSync(path, 'utf8'));
  return { preview, validation: validateTailoringPreview(root, preview), path };
}

export function listResumeWorkspace(root) {
  const variantsDirectory = join(root, 'profile', 'variants');
  const baselines = [];
  const tailoringPreviews = [];
  if (existsSync(variantsDirectory)) {
    for (const name of readdirSync(variantsDirectory)) {
      if (!name.endsWith('.json')) continue;
      try {
        const value = JSON.parse(readFileSync(join(variantsDirectory, name), 'utf8'));
        if (name.startsWith('tailoring.')) {
          const validation = validateTailoringPreview(root, value);
          tailoringPreviews.push({
            id: value.id,
            job_id: value.job_id,
            baseline_variant_id: value.baseline_variant_id,
            change_ratio: value.change_ratio,
            changed_fact_count: value.changed_fact_ids?.length || 0,
            pending_rewrites: value.rewrite_reviews?.filter((item) => item.status === 'pending').length || 0,
            allowed: Boolean(value.allowed),
            stale: !validation.valid,
            errors: validation.errors,
          });
        } else {
          const validation = validateResumeVariant(root, value);
          baselines.push({
            id: value.id,
            template: value.template,
            status: value.status,
            fact_count: value.fact_ids?.length || 0,
            confirmed_at: value.confirmation?.confirmed_at || null,
            stale: !validation.valid,
            errors: validation.errors,
          });
        }
      } catch (error) {
        const id = name.slice(0, -5);
        (name.startsWith('tailoring.') ? tailoringPreviews : baselines).push({ id, stale: true, errors: [{ code: 'stored_json_invalid', message: error.message }] });
      }
    }
  }
  const exports = [];
  const outputDirectory = join(root, 'output', 'careerpilot');
  if (existsSync(outputDirectory)) {
    for (const name of readdirSync(outputDirectory)) {
      if (!name.endsWith('.manifest.json')) continue;
      try {
        const manifest = JSON.parse(readFileSync(join(outputDirectory, name), 'utf8'));
        exports.push({
          manifest: join('output', 'careerpilot', name).replaceAll('\\', '/'),
          output: manifest.output,
          generated_at: manifest.generated_at,
          variant_id: manifest.variant_id,
          tailoring_preview_id: manifest.tailoring_preview_id || null,
          job_id: manifest.job_id || null,
        });
      } catch { /* invalid manifests are not trusted as export records */ }
    }
  }
  return {
    baselines: baselines.sort((left, right) => String(left.id).localeCompare(String(right.id))),
    tailoring_previews: tailoringPreviews.sort((left, right) => String(left.id).localeCompare(String(right.id))),
    exports: exports.sort((left, right) => String(right.generated_at).localeCompare(String(left.generated_at))),
  };
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
  // Clicking export after reviewing the complete diff is the explicit
  // confirmation event for this job-specific variant. The canonical resume
  // exporter still receives a confirmed variant and cannot be bypassed.
  const confirmedVariant = confirmResumeVariant(root, preview.proposed_variant).variant;
  return exportResume(root, confirmedVariant, format, requestedPath, {
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

export async function exportCampaignTailoredResume(root, campaignId, preview, format, requestedPath) {
  const campaign = assertCampaignSelectionCurrent(root, campaignId, preview.job_id);
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
  // A formal artifact carries an immutable TailoringPreview reference. Persist
  // the exact validated preview even when the caller requested an ephemeral
  // preview, so later trust checks can recompute its source hash.
  saveTailoringPreview(root, preview);
  const { posting } = loadJobEvaluation(root, preview.job_id);
  if (preview.proposed_variant.target_job_title !== posting.title) {
    const error = new Error('Resume target title does not match the selected job');
    error.code = 'RESUME_TARGET_MISMATCH';
    throw error;
  }
  const confirmedVariant = confirmResumeVariant(root, preview.proposed_variant).variant;
  const normalizedFormat = String(format).toLowerCase();
  const resumeStyle = loadResumeStyle(root);
  if (resumeStyle.photo.enabled && (!confirmedVariant.sensitive_authorizations.photo || !confirmedVariant.source_photo_sha256)) {
    const error = new Error('The selected resume style enables a photo and therefore requires an explicitly authorized, hash-bound profile photo');
    error.code = 'PHOTO_AUTHORIZATION_REQUIRED';
    throw error;
  }
  const pageBudget = resumeStyle.page_budget;
  const result = await exportResume(root, confirmedVariant, format, requestedPath, {
    pageBudget,
    manifestExtra: {
      schema_version: 2,
      campaign_id: campaign.id,
      job_id: preview.job_id,
      target_job_title: posting.title,
      resume_style: resumeStyle.theme,
      source_resume_style_sha256: sha256(stableJson(resumeStyle)),
      tailoring_preview_id: preview.id,
      baseline_variant_id: preview.baseline_variant_id,
      changed_fact_ids: preview.changed_fact_ids,
      change_ratio: preview.change_ratio,
      maximum_change_ratio: preview.maximum_change_ratio,
      source_campaign_sha256: sha256(stableJson(campaign)),
      source_profile_sha256: preview.source_profile_sha256,
      source_job_sha256: preview.source_job_sha256,
      source_baseline_sha256: preview.baseline_variant_sha256,
      source_tailoring_sha256: sha256(stableJson(preview)),
      selection_confirmation_sha256: sha256(stableJson(campaign.selection)),
      variant_confirmation_sha256: confirmedVariant.confirmation.preview_sha256,
      source_photo_sha256: confirmedVariant.source_photo_sha256,
      photo_included: resumeStyle.photo.enabled && Boolean(confirmedVariant.source_photo_sha256),
      sensitive_authorizations: confirmedVariant.sensitive_authorizations,
      format: normalizedFormat,
      qa: {
        fact_traceability: true,
        semantic_match: true,
        page_count: null,
        page_budget: pageBudget,
        text_layer: ['md', 'html'].includes(normalizedFormat) ? 'not_applicable' : 'pending_docx_render',
        render_status: ['md', 'html'].includes(normalizedFormat) ? 'not_applicable' : 'pending_docx_render',
        truncation: ['md', 'html'].includes(normalizedFormat) ? 'not_applicable' : 'pending_docx_render',
        overlap: ['md', 'html'].includes(normalizedFormat) ? 'not_applicable' : 'pending_docx_render',
        whitespace: ['md', 'html'].includes(normalizedFormat) ? 'not_applicable' : 'pending_docx_render',
        photo_presence: ['md', 'html'].includes(normalizedFormat) ? 'not_applicable' : 'pending_docx_render',
        photo_aspect_ratio: null,
        photo_bounds: ['md', 'html'].includes(normalizedFormat) ? 'not_applicable' : 'pending_docx_render',
      },
    },
  });
  if (['docx', 'pdf'].includes(normalizedFormat)) {
    const profile = loadCandidateProfile(root);
    const byId = new Map(profile.facts.map((fact) => [fact.id, fact.statement]));
    const rewrites = new Map((confirmedVariant.rewrites || []).filter((item) => item.accepted).map((item) => [item.fact_id, item.proposed_statement]));
    const expectedStatements = confirmedVariant.order.map((factId) => rewrites.get(factId) || byId.get(factId)).filter(Boolean);
    try {
      const verify = normalizedFormat === 'docx' ? verifyRenderedResumeDocx : verifyRenderedResumePdf;
      result.manifest.qa = { ...result.manifest.qa, ...await verify(result.path, {
        pageBudget: result.manifest.qa.page_budget,
        targetJobTitle: posting.title,
        expectedStatements,
        density: resumeStyle.density,
        photoExpected: result.manifest.photo_included,
        expectedPhotoAspectRatio: resumeStyle.photo.width_cm / resumeStyle.photo.height_cm,
      }) };
      atomicWrite(`${result.path}.manifest.json`, `${JSON.stringify(result.manifest, null, 2)}\n`);
    } catch (error) {
      rmSync(result.path, { force: true });
      rmSync(`${result.path}.manifest.json`, { force: true });
      throw error;
    }
  }
  const { validateResumeArtifactManifest } = await import('./artifact-core.mjs');
  const manifestValidation = validateResumeArtifactManifest(result.manifest);
  if (!manifestValidation.valid) {
    const error = new Error('Campaign resume artifact manifest validation failed');
    error.code = 'RESUME_ARTIFACT_INVALID';
    error.details = manifestValidation.errors;
    throw error;
  }
  return result;
}
