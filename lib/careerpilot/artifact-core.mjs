import Ajv2020 from 'ajv/dist/2020.js';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCampaignSelectionCurrent, currentProfileSha256 } from './campaign-core.mjs';
import { sha256, stableJson } from './hash-core.mjs';
import { loadJobRecord } from './job-core.mjs';
import { loadResumeStyle } from './resume-style-core.mjs';
import { loadResumeVariant, loadTailoringPreview } from './tailoring-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'cn', 'resume-artifact-manifest.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

export function validateResumeArtifactManifest(manifest) {
  const errors = [];
  if (!validateSchema(manifest)) errors.push(...(validateSchema.errors || []).map((item) => ({ code: 'schema_invalid', path: item.instancePath || '/', message: item.message })));
  if (manifest?.change_ratio > manifest?.maximum_change_ratio) errors.push({ code: 'tailoring_limit_exceeded' });
  if (manifest?.photo_included && (!manifest?.sensitive_authorizations?.photo || !manifest?.source_photo_sha256)) errors.push({ code: 'photo_authorization_invalid' });
  if (manifest?.resume_style === 'compact-photo' && manifest?.photo_included !== true) errors.push({ code: 'photo_required_by_style' });
  if (manifest?.resume_style === 'compact-no-photo' && manifest?.photo_included !== false) errors.push({ code: 'photo_forbidden_by_style' });
  if (['docx', 'pdf'].includes(manifest?.format)) {
    if (!Number.isInteger(manifest?.qa?.page_count)) errors.push({ code: 'render_page_count_missing' });
    if (manifest?.qa?.text_layer !== 'verified') errors.push({ code: 'text_layer_not_verified' });
    if (manifest?.qa?.render_status !== 'verified') errors.push({ code: 'render_not_verified' });
    for (const check of ['truncation', 'overlap', 'whitespace', 'photo_bounds']) {
      const expected = check === 'photo_bounds' && !manifest?.photo_included ? 'not_applicable' : 'verified';
      if (manifest?.qa?.[check] !== expected) errors.push({ code: `${check}_not_verified` });
    }
    if (manifest?.qa?.photo_presence !== (manifest?.photo_included ? 'verified' : 'not_applicable')) errors.push({ code: 'photo_presence_not_verified' });
    if (manifest?.photo_included && !(manifest?.qa?.photo_aspect_ratio > 0)) errors.push({ code: 'photo_aspect_ratio_not_verified' });
    if (manifest?.qa?.page_count > manifest?.qa?.page_budget) errors.push({ code: 'page_budget_exceeded' });
  }
  return { valid: errors.length === 0, errors };
}

function containedRegularFile(container, target, label) {
  if (!existsSync(container) || lstatSync(container).isSymbolicLink() || !lstatSync(container).isDirectory()) throw new Error(`Trusted ${label} container is unavailable`);
  if (!existsSync(target) || lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile()) throw new Error(`Trusted ${label} must be a regular file`);
  const realContainer = realpathSync(container);
  const realTarget = realpathSync(target);
  const contained = relative(realContainer, realTarget);
  if (contained === '' || contained.startsWith('..') || isAbsolute(contained)) throw new Error(`${label} escaped output/careerpilot`);
  return realTarget;
}

function staleArtifact(details) {
  const error = new Error('Resume artifact source data changed after export');
  error.code = 'RESUME_ARTIFACT_STALE';
  error.details = details;
  return error;
}

export function loadTrustedResumeArtifact(root, manifestRef, expected = {}) {
  const outputRoot = resolve(root, 'output', 'careerpilot');
  const manifestPath = resolve(root, manifestRef);
  const relativeManifest = relative(outputRoot, manifestPath);
  if (relativeManifest.startsWith('..') || isAbsolute(relativeManifest) || !manifestPath.endsWith('.manifest.json')) throw new Error('Resume manifest must be under output/careerpilot');
  const realManifest = containedRegularFile(outputRoot, manifestPath, 'resume manifest');
  const manifest = JSON.parse(readFileSync(realManifest, 'utf8'));
  const validation = validateResumeArtifactManifest(manifest);
  if (!validation.valid) {
    const error = new Error('Resume artifact manifest is not trusted');
    error.code = 'RESUME_ARTIFACT_INVALID';
    error.details = validation.errors;
    throw error;
  }
  if (expected.campaign_id && manifest.campaign_id !== expected.campaign_id) throw new Error('Resume artifact belongs to a different Campaign');
  if (expected.job_id && manifest.job_id !== expected.job_id) throw new Error('Resume artifact belongs to a different job');
  if (!['docx', 'pdf'].includes(manifest.format)) {
    const error = new Error('Application packages require a verified DOCX or PDF resume artifact');
    error.code = 'FINAL_RESUME_FORMAT_REQUIRED';
    throw error;
  }
  const campaign = assertCampaignSelectionCurrent(root, manifest.campaign_id, manifest.job_id);
  const { posting, report } = loadJobRecord(root, manifest.job_id);
  const { preview, validation: previewValidation } = loadTailoringPreview(root, manifest.tailoring_preview_id);
  const baseline = loadResumeVariant(root, manifest.baseline_variant_id);
  const variant = loadResumeVariant(root, manifest.variant_id);
  const currentHashes = {
    source_campaign_sha256: sha256(stableJson(campaign)),
    source_profile_sha256: currentProfileSha256(root),
    source_job_sha256: report?.job_sha256 || sha256(stableJson(posting)),
    source_baseline_sha256: sha256(stableJson(baseline)),
    source_tailoring_sha256: sha256(stableJson(preview)),
    source_resume_style_sha256: sha256(stableJson(loadResumeStyle(root))),
    selection_confirmation_sha256: sha256(stableJson(campaign.selection)),
    variant_confirmation_sha256: variant.confirmation?.preview_sha256,
  };
  const changed = Object.entries(currentHashes)
    .filter(([field, value]) => manifest[field] !== value)
    .map(([field]) => field);
  if (!previewValidation.valid) changed.push('tailoring_preview_validity');
  if (posting.title !== manifest.target_job_title) changed.push('target_job_title');
  if (variant.source_photo_sha256 !== manifest.source_photo_sha256) changed.push('source_photo_sha256');
  if (changed.length) throw staleArtifact([...new Set(changed)]);
  const outputPath = resolve(root, manifest.output);
  const relativeOutput = relative(outputRoot, outputPath);
  if (relativeOutput.startsWith('..') || isAbsolute(relativeOutput)) throw new Error('Resume artifact output is missing or escaped output/careerpilot');
  const realOutput = containedRegularFile(outputRoot, outputPath, 'resume artifact');
  const content = readFileSync(realOutput);
  if (sha256(content) !== manifest.content_sha256) throw new Error('Resume artifact content hash mismatch');
  return { manifest, manifest_path: realManifest, output_path: realOutput };
}
