import Ajv2020 from 'ajv/dist/2020.js';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { auditCandidateProfile, loadCandidateProfile } from './profile-core.mjs';
import { renderSectionedHtml } from '../../build-cv-html.mjs';
import { resolveTemplate } from '../../cv-templates.mjs';
import { sha256, stableJson } from './hash-core.mjs';
import { verifyRenderedResumeDocx, verifyRenderedResumePdf } from './artifact-qa-core.mjs';
import { loadResumeStyle, resolveResumeSectionOrder, resolveResumeStyleDefinition, validateResumeStyle } from './resume-style-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const resumeSchemaPath = join(ROOT, 'schemas', 'cn', 'resume-variant.schema.json');
if (!existsSync(resumeSchemaPath)) {
  const error = new Error(`ResumeVariant Schema not found: ${resumeSchemaPath}`);
  error.code = 'SCHEMA_MISSING';
  throw error;
}
const schema = JSON.parse(readFileSync(resumeSchemaPath, 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

const TEMPLATE_IDS = ['soe-one-page', 'tech-two-page', 'application-detail'];
export const RESUME_TEMPLATES = Object.freeze(Object.fromEntries(TEMPLATE_IDS.map((id) => {
  const templatePath = join(ROOT, 'templates', 'cn', `${id}.json`);
  if (!existsSync(templatePath)) {
    const error = new Error(`Resume template not found: ${templatePath}`);
    error.code = 'TEMPLATE_MISSING';
    throw error;
  }
  const template = JSON.parse(readFileSync(templatePath, 'utf8'));
  if (template.id !== id || !Array.isArray(template.type_order) || !Number.isInteger(template.max_pages)) {
    throw new Error(`Invalid resume template definition: ${id}`);
  }
  return [id, Object.freeze(template)];
})));

const FORBIDDEN_SENSITIVE_FIELDS = new Set(['identity_number', 'family_members', 'full_address']);
const ALLOWED_SENSITIVE_FIELDS = new Set(['photo', 'political_status']);
const TYPE_SECTION = {
  basic: '基本信息', summary: '个人概述', education: '教育经历', grade: '教育经历', ranking: '教育经历',
  skill: '专业技能', certificate: '证书与奖项', award: '证书与奖项', campus: '校园经历',
  internship: '实习与工作经历', employment: '实习与工作经历', affiliation: '实习与工作经历',
  project: '项目经历', result: '项目经历', quantified_result: '项目经历',
};

function resumePreviewHash(variant) {
  const preview = structuredClone(variant);
  preview.status = 'draft';
  preview.confirmation = { status: 'pending', confirmed_at: null, preview_sha256: null };
  return sha256(stableJson(preview));
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

function eligibleFacts(root) {
  const profile = loadCandidateProfile(root);
  const audit = auditCandidateProfile(root);
  const byId = new Map(audit.facts.map((item) => [item.id, item]));
  return {
    profile,
    profileHash: existsSync(join(root, 'profile', 'candidate.yml'))
      ? sha256(readFileSync(join(root, 'profile', 'candidate.yml')))
      : sha256(JSON.stringify(profile)),
    eligible: profile.facts.filter((fact) => byId.get(fact.id)?.eligible),
    blocked: profile.facts.filter((fact) => !byId.get(fact.id)?.eligible),
  };
}

function rewritePreservesClaims(source, proposed) {
  const clauses = (value) => String(value)
    .split(/[，。；;！？!?\n]+/u)
    .map((clause) => (clause.toLowerCase().match(/[\p{L}\p{N}%]+/gu) || []).join('|'))
    .filter(Boolean)
    .sort();
  const original = clauses(source);
  const candidate = clauses(proposed);
  return original.length > 0 && JSON.stringify(original) === JSON.stringify(candidate);
}

function orderFacts(facts, template) {
  const priority = new Map(RESUME_TEMPLATES[template].type_order.map((type, index) => [type, index]));
  return [...facts].sort((a, b) => {
    const delta = (priority.get(a.type) ?? 999) - (priority.get(b.type) ?? 999);
    return delta || a.id.localeCompare(b.id);
  });
}

function inspectAuthorizedPhoto(root, profile) {
  const photo = profile.candidate.photo;
  if (!photo) return { valid: false };
  const evidenceRoot = resolve(root, 'profile', 'evidence');
  const photoPath = resolve(root, photo);
  try {
    if (!existsSync(evidenceRoot) || !existsSync(photoPath) || lstatSync(evidenceRoot).isSymbolicLink() || !lstatSync(evidenceRoot).isDirectory() || lstatSync(photoPath).isSymbolicLink() || !lstatSync(photoPath).isFile()) return { valid: false };
    const realProfileRoot = realpathSync(resolve(root, 'profile'));
    const realEvidenceRoot = realpathSync(evidenceRoot);
    const evidenceRelative = relative(realProfileRoot, realEvidenceRoot);
    if (evidenceRelative.startsWith('..') || isAbsolute(evidenceRelative) || evidenceRelative === '') return { valid: false };
    const realPhotoPath = realpathSync(photoPath);
    const photoRelative = relative(realEvidenceRoot, realPhotoPath);
    if (photoRelative.startsWith('..') || isAbsolute(photoRelative) || photoRelative === '' || statSync(realPhotoPath).size > 5 * 1024 * 1024) return { valid: false };
    const bytes = readFileSync(realPhotoPath);
    const png = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const extensionMatches = (png && /\.png$/i.test(realPhotoPath)) || (jpeg && /\.jpe?g$/i.test(realPhotoPath));
    if (!extensionMatches) return { valid: false };
    return { valid: true, path: realPhotoPath, sha256: sha256(bytes), mime: png ? 'image/png' : 'image/jpeg' };
  } catch {
    return { valid: false };
  }
}

function computeVariantDiff(profile, factIds, order, rewrites) {
  const sourceIndex = new Map(factIds.map((id, index) => [id, index]));
  return {
    added: [...factIds],
    removed: profile.facts.filter((fact) => !factIds.includes(fact.id)).map((fact) => fact.id),
    rewritten: rewrites.filter((item) => item.accepted).map((item) => ({ fact_id: item.fact_id, statement: item.proposed_statement })),
    reordered: order.flatMap((factId, to) => sourceIndex.get(factId) === to ? [] : [{ fact_id: factId, from: sourceIndex.get(factId), to }]),
  };
}

export function createResumeVariant(root, options = {}) {
  const template = options.template || 'soe-one-page';
  if (!RESUME_TEMPLATES[template]) throw new Error(`Unknown resume template: ${template}`);
  const { profile, profileHash, eligible } = eligibleFacts(root);
  const eligibleIds = new Set(eligible.map((fact) => fact.id));
  const requestedIds = options.fact_ids ? new Set(options.fact_ids) : eligibleIds;
  const invalidRequested = [...requestedIds].filter((id) => !eligibleIds.has(id));
  if (invalidRequested.length) {
    const error = new Error('ResumeVariant requested Facts that are not publishable');
    error.code = 'FACT_NOT_PUBLISHABLE';
    error.details = invalidRequested;
    throw error;
  }
  const selected = eligible.filter((fact) => requestedIds.has(fact.id));
  const ordered = orderFacts(selected, template);
  const order = options.order || ordered.map((fact) => fact.id);
  const sensitive = { photo: false, political_status: false, ...(options.sensitive_authorizations || {}) };
  const factIds = selected.map((fact) => fact.id);
  const rewrites = options.rewrites || [];
  const photoInspection = sensitive.photo ? inspectAuthorizedPhoto(root, profile) : null;
  const resumeStyleHash = sha256(stableJson(loadResumeStyle(root)));
  const variant = {
    schema_version: 1,
    id: options.id || `resume.${template}.${randomUUID()}`,
    template,
    ...(options.target_job_title ? { target_job_title: String(options.target_job_title).trim().slice(0, 200) } : {}),
    source_profile_sha256: profileHash,
    source_resume_style_sha256: resumeStyleHash,
    source_photo_sha256: photoInspection?.valid ? photoInspection.sha256 : null,
    fact_ids: factIds,
    order,
    rewrites,
    sensitive_authorizations: sensitive,
    status: 'draft',
    confirmation: { status: 'pending', confirmed_at: null, preview_sha256: null },
    diff: computeVariantDiff(profile, factIds, order, rewrites),
  };
  const validation = validateResumeVariant(root, variant);
  if (!validation.valid) {
    const error = new Error('ResumeVariant validation failed');
    error.code = 'RESUME_VARIANT_INVALID';
    error.details = validation.errors;
    throw error;
  }
  return variant;
}

export function validateResumeVariant(root, variant) {
  const errors = [];
  if (!validateSchema(variant)) {
    errors.push(...(validateSchema.errors || []).map((item) => ({ code: 'schema_invalid', path: item.instancePath || '/', message: item.message })));
  }
  const template = RESUME_TEMPLATES[variant?.template];
  if (!template) errors.push({ code: 'unknown_template' });
  const { profile, profileHash, eligible } = eligibleFacts(root);
  if (variant?.source_profile_sha256 !== profileHash) errors.push({ code: 'profile_changed_since_preview' });
  const resumeStyleHash = sha256(stableJson(loadResumeStyle(root)));
  if (variant?.source_resume_style_sha256 !== resumeStyleHash) errors.push({ code: 'resume_style_changed_since_preview' });
  const eligibleIds = new Set(eligible.map((fact) => fact.id));
  const profileIds = new Set(profile.facts.map((fact) => fact.id));
  for (const id of variant?.fact_ids || []) {
    if (!profileIds.has(id)) errors.push({ code: 'unknown_fact', id });
    else if (!eligibleIds.has(id)) errors.push({ code: 'fact_not_publishable', id });
  }
  const factSet = [...new Set(variant?.fact_ids || [])].sort();
  const orderSet = [...new Set(variant?.order || [])].sort();
  if (JSON.stringify(factSet) !== JSON.stringify(orderSet)) errors.push({ code: 'order_mismatch' });
  const rewriteIds = new Set();
  for (const rewrite of variant?.rewrites || []) {
    if (!rewrite.accepted) errors.push({ code: 'rewrite_not_accepted', fact_id: rewrite.fact_id });
    if (!eligibleIds.has(rewrite.fact_id)) errors.push({ code: 'rewrite_fact_not_publishable', fact_id: rewrite.fact_id });
    if (rewriteIds.has(rewrite.fact_id)) errors.push({ code: 'duplicate_rewrite', fact_id: rewrite.fact_id });
    const original = profile.facts.find((fact) => fact.id === rewrite.fact_id)?.statement || '';
    if (!rewritePreservesClaims(original, rewrite.proposed_statement)) {
      errors.push({ code: 'rewrite_introduces_new_claim', fact_id: rewrite.fact_id });
    }
    rewriteIds.add(rewrite.fact_id);
  }
  for (const [field, authorized] of Object.entries(variant?.sensitive_authorizations || {})) {
    if (authorized && FORBIDDEN_SENSITIVE_FIELDS.has(field)) errors.push({ code: 'forbidden_sensitive_field', field });
    else if (!ALLOWED_SENSITIVE_FIELDS.has(field)) errors.push({ code: 'unknown_sensitive_field', field });
  }
  if (variant?.sensitive_authorizations?.photo) {
    const photo = inspectAuthorizedPhoto(root, profile);
    if (!photo.valid) errors.push({ code: 'authorized_photo_unavailable' });
    else if (variant.source_photo_sha256 !== photo.sha256) errors.push({ code: 'photo_changed_since_preview' });
  } else if (variant?.source_photo_sha256 !== null) {
    errors.push({ code: 'unauthorized_photo_hash' });
  }
  const expectedDiff = computeVariantDiff(profile, variant?.fact_ids || [], variant?.order || [], variant?.rewrites || []);
  if (JSON.stringify(variant?.diff) !== JSON.stringify(expectedDiff)) errors.push({ code: 'diff_mismatch' });
  if (variant?.status === 'draft' && variant?.confirmation?.status !== 'pending') errors.push({ code: 'draft_cannot_be_confirmed' });
  if (['ready', 'exported'].includes(variant?.status)) {
    if (variant?.confirmation?.status !== 'confirmed') errors.push({ code: 'ready_variant_not_confirmed' });
    else if (variant.confirmation.preview_sha256 !== resumePreviewHash(variant)) errors.push({ code: 'confirmed_preview_hash_mismatch' });
  }
  return { valid: errors.length === 0, errors };
}

export function confirmResumeVariant(root, draft) {
  const validation = validateResumeVariant(root, draft);
  if (!validation.valid || draft.status !== 'draft' || draft.confirmation?.status !== 'pending') {
    const error = new Error('Only a valid previewed draft ResumeVariant can be confirmed');
    error.code = 'RESUME_CONFIRMATION_INVALID';
    error.details = validation.errors;
    throw error;
  }
  const variant = structuredClone(draft);
  variant.status = 'ready';
  variant.confirmation = {
    status: 'confirmed',
    confirmed_at: new Date().toISOString(),
    preview_sha256: resumePreviewHash(draft),
  };
  const confirmedValidation = validateResumeVariant(root, variant);
  if (!confirmedValidation.valid) {
    const error = new Error('Confirmed ResumeVariant validation failed');
    error.code = 'RESUME_CONFIRMATION_INVALID';
    error.details = confirmedValidation.errors;
    throw error;
  }
  return { variant, path: saveResumeVariant(root, variant) };
}

function normalizedResume(root, variant) {
  const validation = validateResumeVariant(root, variant);
  if (!validation.valid) {
    const error = new Error('ResumeVariant validation failed');
    error.code = 'RESUME_VARIANT_INVALID';
    error.details = validation.errors;
    throw error;
  }
  const profile = loadCandidateProfile(root);
  const facts = new Map(profile.facts.map((fact) => [fact.id, fact]));
  const rewrites = new Map(variant.rewrites.map((item) => [item.fact_id, item.proposed_statement]));
  const sections = [];
  for (const id of variant.order) {
    const fact = facts.get(id);
    const title = TYPE_SECTION[fact.type] || '其他经历';
    let section = sections.find((item) => item.title === title);
    if (!section) {
      section = { title, items: [] };
      sections.push(section);
    }
    section.items.push({ fact_id: id, statement: rewrites.get(id) || fact.statement, type: fact.type });
  }
  const headerFactRank = (item) => {
    const fact = facts.get(item.fact_id);
    if (fact?.type === 'basic' && fact.subtype === 'phone') return 0;
    if (fact?.type === 'basic' && fact.subtype === 'email') return 1;
    if (/^GitHub\s*[：:]/iu.test(item.statement)) return 2;
    return null;
  };
  const headerFacts = [];
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const kept = [];
    for (const item of sections[index].items) {
      if (headerFactRank(item) !== null) headerFacts.push(item);
      else kept.push(item);
    }
    sections[index].items = kept;
    if (!kept.length) sections.splice(index, 1);
  }
  headerFacts.sort((left, right) => headerFactRank(left) - headerFactRank(right));
  const style = loadResumeStyle(root);
  const explicitStyle = existsSync(join(root, 'profile', 'resume-style.yml'));
  if (!explicitStyle && variant.sensitive_authorizations.photo) {
    style.photo.enabled = true;
  }
  if (style.theme === 'soe-outcome' && style.page_budget === 1) {
    const education = sections.find((section) => section.title === '教育经历');
    const credentials = sections.find((section) => section.title === '证书与奖项');
    if (education && credentials) {
      education.items.push(...credentials.items);
      sections.splice(sections.indexOf(credentials), 1);
    }
  }
  const sensitive = {};
  if (style.photo.enabled && variant.sensitive_authorizations.photo && profile.candidate.photo) sensitive.photo = profile.candidate.photo;
  const politicalStatus = profile.schema_version === 2
    ? profile.structured?.political_status?.value
    : profile.candidate.political_status;
  if (variant.sensitive_authorizations.political_status && politicalStatus) sensitive.political_status = politicalStatus;
  const sectionPriority = new Map(resolveResumeSectionOrder(style).map((title, index) => [title, index]));
  sections.sort((left, right) => (sectionPriority.get(left.title) ?? 999) - (sectionPriority.get(right.title) ?? 999));
  return { profile, template: RESUME_TEMPLATES[variant.template], variant, sensitive, headerFacts, sections, style };
}

export function renderResumeMarkdown(root, variant) {
  const model = normalizedResume(root, variant);
  const lines = [`# ${model.profile.candidate.display_name}`, ''];
  if (model.variant.target_job_title) lines.push(`求职方向：${model.variant.target_job_title}`, '');
  if (model.sensitive.political_status) lines.push(`政治面貌：${model.sensitive.political_status}`, '');
  for (const item of model.headerFacts) lines.push(`${item.statement} <!-- fact:${item.fact_id} -->`);
  if (model.headerFacts.length) lines.push('');
  for (const section of model.sections) {
    lines.push(`## ${section.title}`, '');
    for (const item of section.items) lines.push(`- ${item.statement} <!-- fact:${item.fact_id} -->`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function resumeThemeCss(definition) {
  const theme = `.resume-theme-${definition.id}`;
  const headingRules = {
    'rule': `${theme} h2{border-bottom-width:1px}`,
    'heavy-rule': `${theme} h2{border-bottom-width:2px;font-weight:700}`,
    'serif-rule': `${theme} h2{border-bottom-width:1px;font-family:SimSun,serif;letter-spacing:.08em}`,
    'bar-rule': `${theme} h2{border-bottom-width:2px;border-left:0;padding-left:0}`,
    'minimal': `${theme} h2{border-bottom-width:1px;color:var(--resume-ink);font-size:12pt}`,
  };
  return [
    `:root{--resume-accent:${definition.palette.accent};--resume-accent-dark:${definition.palette.accent_dark};--resume-divider:${definition.palette.divider};--resume-muted:${definition.palette.muted};--resume-ink:${definition.palette.ink};--resume-paper:${definition.palette.paper}}`,
    `${theme}{color:var(--resume-ink);background:var(--resume-paper)}`,
    `${theme} header{border-color:var(--resume-accent-dark)}`,
    `${theme} h1,${theme} h2{color:var(--resume-accent-dark)}`,
    `${theme} h2{border-color:var(--resume-divider)}`,
    `${theme} .meta{color:var(--resume-muted)}`,
    `${theme} .portrait,${theme} .portrait-placeholder{border-color:var(--resume-divider)}`,
    definition.header_alignment === 'center'
      ? `${theme} header:not(:has(.portrait)){text-align:center;padding-right:0}${theme} header:not(:has(.portrait)) .meta{justify-content:center}`
      : `${theme} header:not(:has(.portrait)){text-align:left;padding-right:0}`,
    headingRules[definition.heading_style],
  ].join('');
}

function renderNormalizedResumeHtml(root, model, options = {}) {
  const definition = resolveResumeStyleDefinition(model.style);
  const fontPath = join(ROOT, 'node_modules', '@fontsource', 'noto-sans-sc', 'files', 'noto-sans-sc-chinese-simplified-400-normal.woff2');
  const fontCss = existsSync(fontPath)
    ? `@font-face{font-family:"Noto Sans SC";font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${readFileSync(fontPath).toString('base64')}) format("woff2")}`
    : '';
  let photoDataUrl = '';
  if (model.sensitive.photo && !options.photoPlaceholder) {
    const photoPath = resolve(root, model.sensitive.photo);
    const mime = /\.png$/i.test(photoPath) ? 'image/png' : 'image/jpeg';
    photoDataUrl = `data:${mime};base64,${readFileSync(photoPath).toString('base64')}`;
  }
  const templatePath = resolveTemplate('resume', 'standard');
  const html = renderSectionedHtml(readFileSync(templatePath, 'utf8'), {
    name: model.profile.candidate.display_name,
    layout: model.style.page_budget === 2 && model.style.density === 'balanced' ? 'standard' : 'compact',
    themeClass: `resume-theme-${definition.id}`,
    fontCss,
    photoDataUrl,
    photoPlaceholder: Boolean(options.photoPlaceholder),
    meta: [
      model.variant.target_job_title ? `求职方向：${model.variant.target_job_title}` : '',
      ...(model.headerFacts || []).map((item) => item.statement),
      model.sensitive.political_status ? `政治面貌：${model.sensitive.political_status}` : '',
    ],
    sections: model.sections,
  });
  const fontFamily = JSON.stringify(model.style.font_family);
  const pageMargin = `${model.style.page_margin_cm}cm`;
  const photoFit = model.style.photo.crop === 'contain' ? 'contain' : 'cover';
  return html.replace('</style>', `\n@page{margin:${pageMargin}}body,body.compact{font-family:${fontFamily},sans-serif;font-size:${model.style.font_size_pt}pt}.portrait,.portrait-placeholder{width:${model.style.photo.width_cm}cm;height:${model.style.photo.height_cm}cm}.portrait{object-fit:${photoFit}}${resumeThemeCss(definition)}\n</style>`);
}

export function renderResumeHtml(root, variant) {
  return renderNormalizedResumeHtml(root, normalizedResume(root, variant));
}

export function renderAnonymousResumeStylePreview(root, style) {
  const validation = validateResumeStyle(style);
  if (!validation.valid) {
    const error = new Error('Anonymous resume style preview is invalid');
    error.code = 'RESUME_STYLE_INVALID';
    error.details = validation.errors;
    throw error;
  }
  const normalizedStyle = validation.style;
  const previewProfile = yaml.load(readFileSync(join(ROOT, 'examples', 'cn-profile', 'resume-style-preview.yml'), 'utf8'));
  const sections = [];
  for (const fact of previewProfile.facts) {
    const title = TYPE_SECTION[fact.type] || '其他经历';
    let section = sections.find((item) => item.title === title);
    if (!section) {
      section = { title, items: [] };
      sections.push(section);
    }
    section.items.push({ fact_id: `preview.${fact.id}`, type: fact.type, statement: fact.statement });
  }
  const sectionPriority = new Map(resolveResumeSectionOrder(normalizedStyle).map((title, index) => [title, index]));
  sections.sort((left, right) => (sectionPriority.get(left.title) ?? 999) - (sectionPriority.get(right.title) ?? 999));
  return renderNormalizedResumeHtml(root, {
    profile: { candidate: { display_name: previewProfile.candidate.display_name } },
    template: { id: 'anonymous-style-preview', label: '匿名风格预览', max_pages: normalizedStyle.page_budget },
    variant: { id: 'resume.preview.anonymous', target_job_title: '信息技术岗' },
    sensitive: normalizedStyle.photo.enabled ? { photo: '__anonymous_preview__' } : {},
    sections,
    style: normalizedStyle,
  }, { photoPlaceholder: normalizedStyle.photo.enabled });
}

export async function renderResumeDocx(root, variant) {
  const model = normalizedResume(root, variant);
  const definition = resolveResumeStyleDefinition(model.style);
  const {
    AlignmentType, BorderStyle, Document, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableCell, TableRow,
    TextRun, VerticalAlign, WidthType,
  } = await import('docx');
  const dense = model.style.density === 'full' || model.style.page_budget === 1;
  const ink = definition.palette.ink.slice(1);
  const navy = definition.palette.accent_dark.slice(1);
  const divider = definition.palette.divider.slice(1);
  const muted = definition.palette.muted.slice(1);
  const font = { ascii: model.style.font_family, hAnsi: model.style.font_family, eastAsia: model.style.font_family };
  const bodySize = Math.round(model.style.font_size_pt * 2);
  const headingSize = Math.max(bodySize + 4, 20);
  const lineSpacing = model.style.density === 'full' ? 215 : (dense ? 264 : 300);
  const paragraphAfter = model.style.density === 'full' ? 10 : (dense ? 40 : 80);
  const children = [];
  const headerFactStatements = (model.headerFacts || []).map((item) => item.statement);
  const metaLines = [
    model.variant.target_job_title ? `求职方向：${model.variant.target_job_title}` : '',
    headerFactStatements.slice(0, 2).join('  '),
    headerFactStatements.slice(2).join('  '),
    model.sensitive.political_status ? `政治面貌：${model.sensitive.political_status}` : '',
  ].filter(Boolean);
  if (model.style.photo.enabled && model.sensitive.photo) {
    const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    children.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder, insideHorizontal: noBorder, insideVertical: noBorder },
      rows: [new TableRow({ children: [
        new TableCell({
          width: { size: 78, type: WidthType.PERCENTAGE },
          verticalAlign: VerticalAlign.CENTER,
          borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder },
          children: [
            new Paragraph({
              alignment: AlignmentType.LEFT,
              spacing: { after: dense ? 70 : 110 },
              children: [new TextRun({ text: model.profile.candidate.display_name, bold: true, size: Math.max(bodySize + 14, 30), color: navy, font })],
            }),
            ...metaLines.map((text, index) => new Paragraph({
              alignment: AlignmentType.LEFT,
              spacing: { after: index === 0 ? 24 : 8, line: 220 },
              children: [new TextRun({ text, bold: index === 0, size: index === 0 ? bodySize + 3 : bodySize, color: index === 0 ? definition.palette.accent.slice(1) : muted, font })],
            })),
          ],
        }),
        new TableCell({
          width: { size: 22, type: WidthType.PERCENTAGE },
          verticalAlign: VerticalAlign.CENTER,
          borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder },
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { before: 40 },
            children: [new ImageRun({ data: readFileSync(resolve(root, model.sensitive.photo)), transformation: { width: Math.round(model.style.photo.width_cm * 37.8), height: Math.round(model.style.photo.height_cm * 37.8) }, type: /\.png$/i.test(model.sensitive.photo) ? 'png' : 'jpg' })],
          })],
        }),
      ] })],
    }));
  } else {
    children.push(new Paragraph({
      alignment: definition.header_alignment === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT,
      spacing: { after: dense ? 80 : 120 },
      children: [new TextRun({ text: model.profile.candidate.display_name, bold: true, size: Math.max(bodySize + 14, 30), color: navy, font })],
    }));
    for (const [index, text] of metaLines.entries()) children.push(new Paragraph({
      alignment: definition.header_alignment === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT,
      spacing: { after: index === metaLines.length - 1 ? (dense ? 100 : 160) : 20, line: 220 },
      children: [new TextRun({ text, bold: index === 0, size: index === 0 ? bodySize + 3 : bodySize, color: index === 0 ? definition.palette.accent.slice(1) : '435269', font })],
    }));
  }
  for (const section of model.sections) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: model.style.density === 'full' ? 45 : (dense ? 100 : 160), after: model.style.density === 'full' ? 24 : 60 },
      border: { bottom: { style: BorderStyle.SINGLE, size: definition.heading_style === 'heavy-rule' ? 10 : definition.heading_style === 'bar-rule' ? 8 : definition.heading_style === 'minimal' ? 3 : 5, color: divider, space: 2 } },
      children: [new TextRun({ text: section.title, bold: true, size: headingSize, color: navy, font })],
    }));
    for (const item of section.items) {
      const entryHeader = /\.summary$/u.test(item.fact_id) && ['实习与工作经历', '项目经历'].includes(section.title);
      const compactLine = ['教育经历', '个人概述', '专业技能', '证书与奖项'].includes(section.title);
      children.push(new Paragraph({
        ...(entryHeader || compactLine ? {} : { bullet: { level: 0 } }),
        spacing: { before: entryHeader ? 25 : 0, after: entryHeader ? 14 : paragraphAfter, line: lineSpacing },
        children: [
          new TextRun({ text: item.statement, bold: entryHeader, size: bodySize, color: ink, font }),
          new TextRun({ text: ` fact:${item.fact_id}`, vanish: true, size: 2, font }),
        ],
      }));
    }
  }
  const doc = new Document({
    creator: 'CareerPilot CN',
    title: `${model.profile.candidate.display_name} - ${model.template.label}`,
    description: `ResumeVariant ${variant.id}`,
    styles: {
      default: {
        document: {
          run: { font, size: bodySize, color: ink },
          paragraph: { spacing: { after: paragraphAfter, line: lineSpacing } },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: Math.round(model.style.page_margin_cm * 567), right: Math.round(model.style.page_margin_cm * 567), bottom: Math.round(model.style.page_margin_cm * 567), left: Math.round(model.style.page_margin_cm * 567), header: 360, footer: 360 },
        },
      },
      children,
    }],
  });
  return Packer.toBuffer(doc);
}

export function saveResumeVariant(root, variant) {
  const validation = validateResumeVariant(root, variant);
  if (!validation.valid) {
    const error = new Error('ResumeVariant validation failed');
    error.code = 'RESUME_VARIANT_INVALID';
    error.details = validation.errors;
    throw error;
  }
  const path = join(root, 'profile', 'variants', `${variant.id}.json`);
  atomicWrite(path, `${JSON.stringify(variant, null, 2)}\n`);
  return path;
}

export function buildExportManifest(root, variant, outputPath, content, extra = {}) {
  return {
    schema_version: 1,
    variant_id: variant.id,
    template: variant.template,
    fact_ids: variant.fact_ids,
    output: outputPath,
    content_sha256: sha256(content),
    generated_at: new Date().toISOString(),
    ...extra,
  };
}

export async function exportResume(root, variant, format, requestedPath, testHooks = {}) {
  const normalizedFormat = String(format).toLowerCase();
  if (!['md', 'html', 'docx', 'pdf'].includes(normalizedFormat)) throw new Error(`Unsupported resume format: ${format}`);
  if (!['ready', 'exported'].includes(variant?.status)
    || variant?.confirmation?.status !== 'confirmed'
    || !variant?.confirmation?.preview_sha256) {
    const error = new Error('ResumeVariant must be previewed and explicitly confirmed before export');
    error.code = 'RESUME_NOT_CONFIRMED';
    throw error;
  }
  const validation = validateResumeVariant(root, variant);
  if (!validation.valid) {
    const error = new Error('ResumeVariant validation failed before export');
    error.code = 'RESUME_VARIANT_INVALID';
    error.details = validation.errors;
    throw error;
  }
  const model = normalizedResume(root, variant);
  const expectedStatements = [
    ...(model.headerFacts || []).map((item) => item.statement),
    ...model.sections.flatMap((section) => section.items.map((item) => item.statement)),
  ];
  const qaOptions = {
    pageBudget: testHooks.pageBudget ?? model.style.page_budget,
    density: model.style.density,
    expectedStatements,
    targetJobTitle: variant.target_job_title,
    photoExpected: Boolean(model.sensitive.photo),
    expectedPhotoAspectRatio: model.style.photo.width_cm / model.style.photo.height_cm,
  };
  const outputRoot = resolve(root, 'output', 'careerpilot');
  const outputPath = requestedPath
    ? resolve(root, requestedPath)
    : join(outputRoot, `${variant.template}-${variant.id.slice(-8)}.${normalizedFormat}`);
  const relativeOutput = relative(outputRoot, outputPath);
  if (relativeOutput.startsWith('..') || isAbsolute(relativeOutput) || relativeOutput === '' || extname(outputPath).toLowerCase() !== `.${normalizedFormat}`) {
    throw new Error('Resume exports must be written under output/careerpilot with the requested extension');
  }
  const manifestPath = `${outputPath}.manifest.json`;
  for (const target of [outputPath, manifestPath]) if (existsSync(target)) throw new Error(`Resume export target already exists: ${target}`);
  mkdirSync(dirname(outputPath), { recursive: true });
  const temporary = join(dirname(outputPath), `.${basename(outputPath)}.${randomUUID()}.tmp.${normalizedFormat}`);
  let bytes;
  let renderResult = null;
  try {
    if (normalizedFormat === 'md') bytes = Buffer.from(renderResumeMarkdown(root, variant), 'utf8');
    else if (normalizedFormat === 'html') bytes = Buffer.from(renderResumeHtml(root, variant), 'utf8');
    else if (normalizedFormat === 'docx') bytes = await renderResumeDocx(root, variant);
    else {
      const { renderHtmlToPdf } = await import('../../generate-pdf.mjs');
      const result = await renderHtmlToPdf(renderResumeHtml(root, variant), temporary, {
        baseDir: root,
        maxPages: qaOptions.pageBudget,
        strictPages: true,
        updateManifest: false,
        quiet: true,
      });
      renderResult = result;
      bytes = readFileSync(temporary);
      if (!result.size) throw new Error('PDF renderer returned an empty file');
    }
    if (normalizedFormat !== 'pdf') writeFileSync(temporary, bytes);
    if (normalizedFormat === 'docx') renderResult = await verifyRenderedResumeDocx(temporary, qaOptions);
    else if (normalizedFormat === 'pdf') renderResult = await verifyRenderedResumePdf(temporary, qaOptions);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  const suppliedExtra = testHooks.manifestExtra || {};
  const qa = ['docx', 'pdf'].includes(normalizedFormat) ? {
    ...(suppliedExtra.qa || {}),
    ...renderResult,
  } : suppliedExtra.qa;
  const manifest = buildExportManifest(root, variant, relative(root, outputPath).replaceAll('\\', '/'), bytes, {
    ...suppliedExtra,
    ...(qa ? { qa } : {}),
  });
  const manifestTemporary = `${manifestPath}.${randomUUID()}.tmp`;
  let manifestPublished = false;
  let committed = false;
  try {
    writeFileSync(manifestTemporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    linkSync(manifestTemporary, manifestPath);
    manifestPublished = true;
    try { rmSync(manifestTemporary, { force: true }); } catch { /* best-effort temp cleanup */ }
    linkSync(temporary, outputPath);
    committed = true;
  } catch (error) {
    rmSync(temporary, { force: true });
    rmSync(manifestTemporary, { force: true });
    if (manifestPublished && !committed) rmSync(manifestPath, { force: true });
    throw error;
  }
  try {
    testHooks.beforeCommittedCleanup?.();
    rmSync(temporary, { force: true });
  } catch { /* committed output remains successful */ }
  return { path: outputPath, manifest };
}
