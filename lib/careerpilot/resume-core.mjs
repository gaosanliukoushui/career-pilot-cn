import Ajv2020 from 'ajv/dist/2020.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCandidateProfile, loadCandidateProfile } from './profile-core.mjs';
import { renderSectionedHtml } from '../../build-cv-html.mjs';
import { resolveTemplate } from '../../cv-templates.mjs';

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
  basic: '基本信息', education: '教育经历', grade: '教育经历', ranking: '教育经历',
  skill: '专业技能', certificate: '证书与奖项', award: '证书与奖项', campus: '校园经历',
  internship: '实习与工作经历', employment: '实习与工作经历', affiliation: '实习与工作经历',
  project: '项目经历', result: '项目经历', quantified_result: '项目经历',
};

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
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
  const variant = {
    schema_version: 1,
    id: options.id || `resume.${template}.${randomUUID()}`,
    template,
    source_profile_sha256: profileHash,
    source_photo_sha256: photoInspection?.valid ? photoInspection.sha256 : null,
    fact_ids: factIds,
    order,
    rewrites,
    sensitive_authorizations: sensitive,
    status: options.status || 'draft',
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
  return { valid: errors.length === 0, errors };
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
  const sensitive = {};
  if (variant.sensitive_authorizations.photo && profile.candidate.photo) sensitive.photo = profile.candidate.photo;
  if (variant.sensitive_authorizations.political_status && profile.candidate.political_status) sensitive.political_status = profile.candidate.political_status;
  return { profile, template: RESUME_TEMPLATES[variant.template], variant, sensitive, sections };
}

export function renderResumeMarkdown(root, variant) {
  const model = normalizedResume(root, variant);
  const lines = [`# ${model.profile.candidate.display_name}`, ''];
  if (model.sensitive.political_status) lines.push(`政治面貌：${model.sensitive.political_status}`, '');
  for (const section of model.sections) {
    lines.push(`## ${section.title}`, '');
    for (const item of section.items) lines.push(`- ${item.statement} <!-- fact:${item.fact_id} -->`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderResumeHtml(root, variant) {
  const model = normalizedResume(root, variant);
  const fontPath = join(ROOT, 'node_modules', '@fontsource', 'noto-sans-sc', 'files', 'noto-sans-sc-chinese-simplified-400-normal.woff2');
  const fontCss = existsSync(fontPath)
    ? `@font-face{font-family:"Noto Sans SC";font-style:normal;font-weight:100 900;src:url(data:font/woff2;base64,${readFileSync(fontPath).toString('base64')}) format("woff2")}`
    : '';
  let photoDataUrl = '';
  if (model.sensitive.photo) {
    const photoPath = resolve(root, model.sensitive.photo);
    const mime = /\.png$/i.test(photoPath) ? 'image/png' : 'image/jpeg';
    photoDataUrl = `data:${mime};base64,${readFileSync(photoPath).toString('base64')}`;
  }
  const templatePath = resolveTemplate('resume', 'standard');
  return renderSectionedHtml(readFileSync(templatePath, 'utf8'), {
    name: model.profile.candidate.display_name,
    layout: model.template.layout,
    fontCss,
    photoDataUrl,
    meta: model.sensitive.political_status ? [`政治面貌：${model.sensitive.political_status}`] : [],
    sections: model.sections,
  });
}

export async function renderResumeDocx(root, variant) {
  const model = normalizedResume(root, variant);
  const {
    AlignmentType, BorderStyle, Document, HeadingLevel, ImageRun, Packer, Paragraph, TextRun,
  } = await import('docx');
  const dense = model.template.layout === 'compact';
  const ink = '172033';
  const navy = '173A63';
  const font = { ascii: 'Microsoft YaHei', hAnsi: 'Noto Sans CJK SC', eastAsia: 'Microsoft YaHei' };
  const children = [];
  if (model.sensitive.photo) {
    children.push(new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { after: 40 },
      children: [new ImageRun({ data: readFileSync(resolve(root, model.sensitive.photo)), transformation: { width: 76, height: 98 }, type: /\.png$/i.test(model.sensitive.photo) ? 'png' : 'jpg' })],
    }));
  }
  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: dense ? 80 : 120 },
      children: [new TextRun({ text: model.profile.candidate.display_name, bold: true, size: 34, color: navy, font })],
    }),
  );
  const meta = model.sensitive.political_status ? [`政治面貌：${model.sensitive.political_status}`] : [];
  if (meta.length) children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: dense ? 100 : 160 },
    children: [new TextRun({ text: meta.join('  |  '), size: 18, color: '435269', font })],
  }));
  for (const section of model.sections) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: dense ? 100 : 160, after: 60 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 5, color: '9BAABD', space: 2 } },
      children: [new TextRun({ text: section.title, bold: true, size: 24, color: navy, font })],
    }));
    for (const item of section.items) {
      children.push(new Paragraph({
        bullet: { level: 0 },
        spacing: { after: dense ? 40 : 80, line: dense ? 276 : 300 },
        children: [
          new TextRun({ text: item.statement, size: dense ? 19 : 20, color: ink, font }),
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
          run: { font, size: dense ? 19 : 20, color: ink },
          paragraph: { spacing: { after: dense ? 40 : 80, line: dense ? 276 : 300 } },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: dense
            ? { top: 680, right: 850, bottom: 680, left: 850, header: 360, footer: 360 }
            : { top: 900, right: 1020, bottom: 900, left: 1020, header: 420, footer: 420 },
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

export function buildExportManifest(root, variant, outputPath, content) {
  return {
    schema_version: 1,
    variant_id: variant.id,
    template: variant.template,
    fact_ids: variant.fact_ids,
    output: outputPath,
    content_sha256: sha256(content),
    generated_at: new Date().toISOString(),
  };
}

export async function exportResume(root, variant, format, requestedPath, testHooks = {}) {
  const normalizedFormat = String(format).toLowerCase();
  if (!['md', 'html', 'docx', 'pdf'].includes(normalizedFormat)) throw new Error(`Unsupported resume format: ${format}`);
  const validation = validateResumeVariant(root, variant);
  if (!validation.valid) {
    const error = new Error('ResumeVariant validation failed before export');
    error.code = 'RESUME_VARIANT_INVALID';
    error.details = validation.errors;
    throw error;
  }
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
  const temporary = join(dirname(outputPath), `.${basename(outputPath)}.${randomUUID()}.tmp`);
  let bytes;
  try {
    if (normalizedFormat === 'md') bytes = Buffer.from(renderResumeMarkdown(root, variant), 'utf8');
    else if (normalizedFormat === 'html') bytes = Buffer.from(renderResumeHtml(root, variant), 'utf8');
    else if (normalizedFormat === 'docx') bytes = await renderResumeDocx(root, variant);
    else {
      const { renderHtmlToPdf } = await import('../../generate-pdf.mjs');
      const result = await renderHtmlToPdf(renderResumeHtml(root, variant), temporary, {
        baseDir: root,
        maxPages: RESUME_TEMPLATES[variant.template].max_pages,
        strictPages: variant.template !== 'application-detail',
        updateManifest: false,
      });
      bytes = readFileSync(temporary);
      if (!result.size) throw new Error('PDF renderer returned an empty file');
    }
    if (normalizedFormat !== 'pdf') writeFileSync(temporary, bytes);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  const manifest = buildExportManifest(root, variant, relative(root, outputPath).replaceAll('\\', '/'), bytes);
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
