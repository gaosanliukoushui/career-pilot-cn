import Ajv2020 from 'ajv/dist/2020.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inferJobPosting, loadJobRecord, parseJobFile, parseJobUrl, saveJobPosting, validateJobPosting } from './job-core.mjs';
import { loadCandidateProfile } from './profile-core.mjs';
import { sha256, stableJson } from './hash-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'cn', 'campaign.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

function clean(value, maximum = 500) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function now() { return new Date().toISOString(); }

function campaignPath(root, id) {
  if (!/^campaign\.[a-f0-9]{24}$/.test(id)) throw new Error('Invalid Campaign ID');
  return join(root, 'data', 'careerpilot', 'campaigns', `${id}.json`);
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(temporary, path);
}

function pendingRanking() {
  return { status: 'pending', generated_at: null, source_sha256: null, profile_sha256: null, entries: [] };
}

function pendingSelection() {
  return { status: 'pending', job_ids: [], confirmed_at: null, reason: null, ranking_sha256: null };
}

function resetDecision(campaign) {
  campaign.ranking = pendingRanking();
  campaign.selection = pendingSelection();
}

function event(type, details = {}) {
  return { type, recorded_at: now(), details };
}

function saveCampaign(root, campaign) {
  campaign.updated_at = now();
  const validation = validateCampaign(campaign);
  if (!validation.valid) {
    const error = new Error('Campaign validation failed');
    error.code = 'CAMPAIGN_INVALID';
    error.details = validation.errors;
    throw error;
  }
  atomicWrite(campaignPath(root, campaign.id), campaign);
  return campaign;
}

export function validateCampaign(campaign) {
  const errors = [];
  if (!validateSchema(campaign)) {
    errors.push(...(validateSchema.errors || []).map((item) => ({ code: 'schema_invalid', path: item.instancePath || '/', message: item.message })));
  }
  const jobIds = (campaign?.jobs || []).map((item) => item.job_id);
  if (new Set(jobIds).size !== jobIds.length) errors.push({ code: 'duplicate_job_id' });
  const maxConstraint = (campaign?.constraints || []).find((item) => item.kind === 'max_applications' && item.confirmation_status !== 'rejected');
  if (!maxConstraint || !Number.isSafeInteger(maxConstraint.value) || maxConstraint.value < 1) errors.push({ code: 'invalid_max_applications' });
  if ((campaign?.selection?.job_ids || []).length > (maxConstraint?.value || 0)) errors.push({ code: 'selection_limit_exceeded' });
  if ((campaign?.selection?.job_ids || []).some((id) => !jobIds.includes(id))) errors.push({ code: 'selected_job_not_in_campaign' });
  for (const constraint of (campaign?.constraints || []).filter((item) => item.kind === 'mutually_exclusive' && item.confirmation_status === 'confirmed')) {
    const exclusiveIds = constraint.value?.job_ids;
    if (!Array.isArray(exclusiveIds) || exclusiveIds.length < 2 || new Set(exclusiveIds).size !== exclusiveIds.length || exclusiveIds.some((id) => !jobIds.includes(id))) {
      errors.push({ code: 'invalid_mutually_exclusive_constraint', constraint_id: constraint.id });
    }
    if ((campaign?.selection?.job_ids || []).filter((id) => exclusiveIds?.includes(id)).length > 1) errors.push({ code: 'mutually_exclusive_selection', constraint_id: constraint.id });
  }
  return { valid: errors.length === 0, errors };
}

export function createCampaign(root, input = {}) {
  const createdAt = now();
  const name = clean(input.name, 200);
  const employer = clean(input.employer, 200);
  if (!name || !employer) throw new Error('Campaign name and employer are required');
  const maxApplications = Number(input.max_applications ?? 1);
  if (!Number.isSafeInteger(maxApplications) || maxApplications < 1) throw new Error('max_applications must be a positive integer');
  const campaign = {
    schema_version: 1,
    id: `campaign.${sha256(`${name}|${employer}|${createdAt}|${randomUUID()}`).slice(0, 24)}`,
    name,
    employer,
    recruitment_batch: clean(input.recruitment_batch, 200),
    deadline: input.deadline || null,
    constraints: [{
      id: 'constraint.max_applications', kind: 'max_applications', value: maxApplications,
      confirmation_status: input.constraint_confirmation_status || 'pending',
      source_quote: clean(input.constraint_source_quote, 1000),
    }],
    jobs: [],
    ranking: pendingRanking(),
    selection: pendingSelection(),
    audit_events: [event('campaign_created', { max_applications: maxApplications })],
    created_at: createdAt,
    updated_at: createdAt,
  };
  return saveCampaign(root, campaign);
}

export function loadCampaign(root, id) {
  const path = campaignPath(root, id);
  if (!existsSync(path)) throw new Error(`Campaign not found: ${id}`);
  const campaign = JSON.parse(readFileSync(path, 'utf8'));
  const validation = validateCampaign(campaign);
  if (!validation.valid) throw new Error(`Stored Campaign is invalid: ${id}`);
  return campaign;
}

export function confirmCampaignConstraints(root, id, input = {}) {
  const campaign = loadCampaign(root, id);
  if (input.max_applications !== undefined) {
    const maximum = Number(input.max_applications);
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('max_applications must be a positive integer');
    const constraint = campaign.constraints.find((item) => item.kind === 'max_applications');
    constraint.value = maximum;
    constraint.confirmation_status = 'confirmed';
    constraint.source_quote = clean(input.max_applications_source_quote || constraint.source_quote, 1000);
    if (!constraint.source_quote) throw new Error('Confirmed max_applications requires a source quote');
  }
  if (input.mutually_exclusive !== undefined) {
    if (!Array.isArray(input.mutually_exclusive)) throw new Error('mutually_exclusive must be an array');
    const campaignJobs = new Set(campaign.jobs.map((item) => item.job_id));
    const constraints = input.mutually_exclusive.map((item, index) => {
      const jobIds = Array.isArray(item.job_ids) ? [...new Set(item.job_ids)] : [];
      if (jobIds.length < 2 || jobIds.some((jobId) => !campaignJobs.has(jobId))) throw new Error('Mutually exclusive constraints require at least two Campaign jobs');
      const sourceQuote = clean(item.source_quote, 1000);
      if (!sourceQuote) throw new Error('Confirmed mutually exclusive constraint requires a source quote');
      return {
        id: `constraint.mutually_exclusive.${sha256(stableJson({ job_ids: jobIds.sort(), index })).slice(0, 12)}`,
        kind: 'mutually_exclusive', value: { job_ids: jobIds }, confirmation_status: 'confirmed', source_quote: sourceQuote,
      };
    });
    campaign.constraints = [...campaign.constraints.filter((item) => item.kind !== 'mutually_exclusive'), ...constraints];
  }
  resetDecision(campaign);
  campaign.audit_events.push(event('campaign_constraints_confirmed', { mutually_exclusive_count: campaign.constraints.filter((item) => item.kind === 'mutually_exclusive').length }));
  return saveCampaign(root, campaign);
}

export function listCampaigns(root) {
  const directory = join(root, 'data', 'careerpilot', 'campaigns');
  if (!existsSync(directory)) return [];
  const campaigns = [];
  for (const name of readdirSync(directory)) {
    if (!/^campaign\.[a-f0-9]{24}\.json$/.test(name)) continue;
    try { campaigns.push(loadCampaign(root, name.slice(0, -5))); } catch { /* invalid records are not trusted */ }
  }
  return campaigns.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

async function postingFromSource(source, options = {}) {
  if (!source || typeof source !== 'object') throw new Error('Campaign source must be an object');
  if (source.kind === 'posting') {
    const validation = validateJobPosting(source.posting);
    if (!validation.valid) {
      const error = new Error('Campaign JobPosting source is invalid');
      error.details = validation.errors;
      throw error;
    }
    return structuredClone(source.posting);
  }
  if (source.kind === 'text') return inferJobPosting(source.text, { kind: 'pasted_text' }, source.hints || {});
  if (source.kind === 'url') return parseJobUrl(source.url, source.hints || {}, options.fetchImpl);
  if (source.kind === 'file') return parseJobFile(source.path, { ...(source.hints || {}), allowed_root: options.allowedRoot });
  if (source.kind === 'browser_capture') {
    if (!clean(source.url, 2000)) throw new Error('Browser capture URL is required');
    return inferJobPosting(source.captured_text, {
      kind: 'public_url', ref: source.url, final_url: source.final_url || source.url,
      fetched_at: source.captured_at || now(), page_title: source.title || '', capture_method: 'browser',
      capture_provider: source.provider || 'external-browser', official: false, official_basis: 'unconfirmed',
      official_evidence: '等待用户核对招聘单位域名或正式招聘平台',
    }, { ...(source.hints || {}), captured_at: source.captured_at || now() });
  }
  throw new Error(`Unsupported Campaign source kind: ${source.kind}`);
}

export async function importCampaignSources(root, id, sources, options = {}) {
  if (!Array.isArray(sources) || !sources.length) throw new Error('Campaign import requires at least one source');
  const campaign = loadCampaign(root, id);
  const existingRefs = new Set(campaign.jobs.map((entry) => clean(entry.source_ref, 2000)).filter(Boolean));
  const existingContent = new Set(campaign.jobs.map((entry) => entry.content_sha256));
  const imported = [];
  const duplicates = [];
  const failures = [];
  for (const [index, source] of sources.entries()) {
    try {
      const sourceRef = clean(source?.url || source?.path || '', 2000);
      if (sourceRef && existingRefs.has(sourceRef)) {
        duplicates.push({ index, reason: 'source_ref', ref: sourceRef });
        continue;
      }
      let posting = await postingFromSource(source, options);
      const resolvedRef = clean(posting.source.final_url || posting.source.ref || sourceRef, 2000);
      if (existingContent.has(posting.content_sha256) || (resolvedRef && existingRefs.has(resolvedRef))) {
        duplicates.push({ index, reason: existingContent.has(posting.content_sha256) ? 'content_sha256' : 'source_ref', ref: resolvedRef || null });
        continue;
      }
      try {
        const existingRecord = loadJobRecord(root, posting.id);
        if (existingRecord.posting.content_sha256 === posting.content_sha256) posting = existingRecord.posting;
        else saveJobPosting(root, posting);
      } catch (error) {
        if (error?.code !== 'JOB_RECORD_NOT_FOUND') throw error;
        saveJobPosting(root, posting);
      }
      campaign.jobs.push({
        job_id: posting.id, content_sha256: posting.content_sha256, source_ref: resolvedRef,
        match_report_id: null, match_report_sha256: null,
        status: 'included', exclusion_reason: null, added_at: now(),
      });
      existingContent.add(posting.content_sha256);
      if (resolvedRef) existingRefs.add(resolvedRef);
      imported.push(posting.id);
    } catch (error) {
      failures.push({ index, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (imported.length) {
    resetDecision(campaign);
    campaign.audit_events.push(event('sources_imported', { imported, duplicate_count: duplicates.length, failure_count: failures.length }));
    saveCampaign(root, campaign);
  }
  return { campaign: loadCampaign(root, id), imported, duplicates, failures };
}

export function excludeCampaignJob(root, id, jobId, options = {}) {
  const campaign = loadCampaign(root, id);
  const entry = campaign.jobs.find((item) => item.job_id === jobId);
  if (!entry) throw new Error(`Job is not linked to Campaign: ${jobId}`);
  const reason = clean(options.reason, 1000);
  if (!reason) throw new Error('Campaign exclusion reason is required');
  entry.status = 'excluded';
  entry.exclusion_reason = reason;
  resetDecision(campaign);
  campaign.audit_events.push(event('job_excluded', { job_id: jobId, reason }));
  return saveCampaign(root, campaign);
}

export function currentProfileSha256(root) {
  const path = join(root, 'profile', 'candidate.yml');
  return existsSync(path) ? sha256(readFileSync(path)) : sha256(stableJson(loadCandidateProfile(root)));
}

function rankingInputs(root, campaign, { enforceMatchBindings = false } = {}) {
  const problems = [];
  const max = campaign.constraints.find((item) => item.kind === 'max_applications' && item.confirmation_status === 'confirmed');
  if (!max) problems.push({ code: 'campaign_constraint_pending' });
  const today = new Date().toISOString().slice(0, 10);
  if (campaign.deadline && campaign.deadline < today) problems.push({ code: 'campaign_deadline_expired', deadline: campaign.deadline });
  const profile = loadCandidateProfile(root);
  const publishable = new Set(profile.facts.filter((fact) => fact.status === 'confirmed' && fact.allowed_uses?.includes('job_match')).map((fact) => fact.id));
  const records = [];
  for (const entry of campaign.jobs.filter((item) => item.status === 'included')) {
    try {
      const record = loadJobRecord(root, entry.job_id);
      if (record.posting.content_sha256 !== entry.content_sha256) problems.push({ code: 'job_snapshot_changed', job_id: entry.job_id });
      if (record.posting.confirmation.status !== 'confirmed') problems.push({ code: 'job_not_confirmed', job_id: entry.job_id });
      if (['closed', 'expired'].includes(record.posting.posting_status)) problems.push({ code: 'job_not_active', job_id: entry.job_id, status: record.posting.posting_status });
      if (record.posting.recruitment?.deadline && record.posting.recruitment.deadline < today) problems.push({ code: 'job_deadline_expired', job_id: entry.job_id, deadline: record.posting.recruitment.deadline });
      if (!record.report) problems.push({ code: 'match_report_missing', job_id: entry.job_id });
      else {
        const reportSha256 = sha256(stableJson(record.report));
        if (enforceMatchBindings && (entry.match_report_id !== record.report.id || entry.match_report_sha256 !== reportSha256)) {
          problems.push({ code: 'match_report_changed', job_id: entry.job_id });
        }
        records.push({ ...record, report_sha256: reportSha256 });
      }
    } catch (error) {
      problems.push({ code: 'job_record_invalid', job_id: entry.job_id, message: error.message });
    }
  }
  if (!campaign.jobs.some((item) => item.status === 'included')) problems.push({ code: 'campaign_has_no_included_jobs' });
  const profileSha256 = currentProfileSha256(root);
  for (const { posting, report } of records) {
    if (report.profile_sha256 !== profileSha256) problems.push({ code: 'match_report_profile_stale', job_id: posting.id });
  }
  return { problems, records, profileSha256, publishable };
}

function rankingSourceHash(campaign, profileSha256, records) {
  return sha256(stableJson({
    campaign: { id: campaign.id, constraints: campaign.constraints, jobs: campaign.jobs },
    profile_sha256: profileSha256,
    records: records.map(({ posting, report, report_sha256 }) => ({ job_id: posting.id, job_sha256: report.job_sha256, match_id: report.id, match_sha256: report_sha256 })),
  }));
}

export function rankCampaign(root, id) {
  const campaign = loadCampaign(root, id);
  const { problems, records, profileSha256, publishable } = rankingInputs(root, campaign);
  if (problems.length) {
    const error = new Error('Campaign is not ready for ranking');
    error.code = 'CAMPAIGN_NOT_READY';
    error.details = problems;
    throw error;
  }
  const eligibilityOrder = { eligible: 3, unknown: 2, ineligible: 1 };
  const recommendationOrder = { apply: 4, consider: 3, need_more_info: 2, do_not_apply: 1 };
  const entries = records.map(({ posting, report }) => {
    const referenced = new Set([
      ...report.fit.dimensions.flatMap((item) => item.candidate_fact_ids),
      ...report.eligibility.rule_results.flatMap((item) => item.candidate_fact_ids),
    ].filter((id) => publishable.has(id)));
    return {
      rank: 0, job_id: posting.id, title: posting.title, eligibility: report.eligibility.result,
      recommendation: report.recommendation, fit_score: report.fit.score,
      fact_coverage: publishable.size ? Math.round((referenced.size / publishable.size) * 10000) / 10000 : 0,
      gap_count: report.gaps.length,
      hard_rule_results: report.eligibility.rule_results,
      evidence_fact_ids: [...referenced].sort(),
      gaps: report.gaps,
      unknowns: report.eligibility.rule_results.filter((item) => item.result === 'unknown').map((item) => item.reason),
    };
  }).sort((left, right) => (
    eligibilityOrder[right.eligibility] - eligibilityOrder[left.eligibility]
    || recommendationOrder[right.recommendation] - recommendationOrder[left.recommendation]
    || right.fit_score - left.fit_score
    || right.fact_coverage - left.fact_coverage
    || left.gap_count - right.gap_count
    || left.job_id.localeCompare(right.job_id)
  )).map((entry, index) => ({ ...entry, rank: index + 1 }));
  for (const { posting, report, report_sha256: reportSha256 } of records) {
    const linked = campaign.jobs.find((item) => item.job_id === posting.id);
    linked.match_report_id = report.id;
    linked.match_report_sha256 = reportSha256;
  }
  const sourceSha256 = rankingSourceHash(campaign, profileSha256, records);
  campaign.ranking = { status: 'ready', generated_at: now(), source_sha256: sourceSha256, profile_sha256: profileSha256, entries };
  campaign.selection = pendingSelection();
  campaign.audit_events.push(event('campaign_ranked', { source_sha256: sourceSha256, job_count: entries.length }));
  return saveCampaign(root, campaign);
}

export function selectCampaignJobs(root, id, jobIds, options = {}) {
  const campaign = loadCampaign(root, id);
  if (!Array.isArray(jobIds) || !jobIds.length || new Set(jobIds).size !== jobIds.length) throw new Error('Select one or more unique Campaign jobs');
  const max = campaign.constraints.find((item) => item.kind === 'max_applications' && item.confirmation_status === 'confirmed')?.value;
  if (!max || jobIds.length > max) {
    const error = new Error('Campaign selection exceeds the confirmed application limit');
    error.code = 'CAMPAIGN_SELECTION_LIMIT';
    error.details = { maximum: max || null, requested: jobIds.length };
    throw error;
  }
  for (const constraint of campaign.constraints.filter((item) => item.kind === 'mutually_exclusive' && item.confirmation_status === 'confirmed')) {
    const conflicting = jobIds.filter((jobId) => constraint.value.job_ids.includes(jobId));
    if (conflicting.length > 1) {
      const error = new Error('Campaign selection includes mutually exclusive jobs');
      error.code = 'CAMPAIGN_MUTUAL_EXCLUSION';
      error.details = { constraint_id: constraint.id, job_ids: conflicting };
      throw error;
    }
  }
  if (campaign.ranking.status !== 'ready') {
    const error = new Error('Campaign must be ranked before selection');
    error.code = 'CAMPAIGN_RANKING_STALE';
    throw error;
  }
  const { problems, records, profileSha256 } = rankingInputs(root, campaign, { enforceMatchBindings: true });
  const currentSource = problems.length ? null : rankingSourceHash(campaign, profileSha256, records);
  if (problems.length || currentSource !== campaign.ranking.source_sha256) {
    const error = new Error('Campaign ranking is stale');
    error.code = 'CAMPAIGN_RANKING_STALE';
    error.details = problems;
    throw error;
  }
  const rankedIds = new Set(campaign.ranking.entries.map((entry) => entry.job_id));
  if (jobIds.some((jobId) => !rankedIds.has(jobId))) throw new Error('Selected job is not in the current Campaign ranking');
  const reason = clean(options.reason, 1000);
  if (!reason) throw new Error('Campaign selection reason is required');
  campaign.selection = { status: 'confirmed', job_ids: [...jobIds], confirmed_at: now(), reason, ranking_sha256: campaign.ranking.source_sha256 };
  campaign.audit_events.push(event('campaign_selection_confirmed', { job_ids: jobIds, reason }));
  return saveCampaign(root, campaign);
}

export function assertCampaignSelectionCurrent(root, campaignId, jobId) {
  const campaign = loadCampaign(root, campaignId);
  if (campaign.selection.status !== 'confirmed' || !campaign.selection.job_ids.includes(jobId)) {
    const error = new Error('Job is not an explicitly selected Campaign target');
    error.code = 'CAMPAIGN_JOB_NOT_SELECTED';
    throw error;
  }
  const { problems, records, profileSha256 } = rankingInputs(root, campaign, { enforceMatchBindings: true });
  const currentSource = problems.length ? null : rankingSourceHash(campaign, profileSha256, records);
  if (problems.length || currentSource !== campaign.selection.ranking_sha256) {
    const error = new Error('Campaign selection is stale');
    error.code = 'CAMPAIGN_SELECTION_STALE';
    error.details = problems;
    throw error;
  }
  return campaign;
}
