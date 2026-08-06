import Ajv2020 from 'ajv/dist/2020.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { auditCandidateProfile, loadCandidateProfile } from './profile-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'cn', 'resume-style.schema.json'), 'utf8'));
const definitionSchema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'cn', 'resume-style-definition.schema.json'), 'utf8'));
const rawCatalog = JSON.parse(readFileSync(join(ROOT, 'templates', 'cn', 'resume-style-catalog.json'), 'utf8'));
const editorialPolicy = JSON.parse(readFileSync(join(ROOT, 'templates', 'cn', 'soe-editorial-policy.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);
const validateDefinition = ajv.compile(definitionSchema);

for (const definition of rawCatalog.styles || []) {
  if (!validateDefinition(definition)) {
    throw new Error(`Invalid ResumeStyleDefinition ${definition?.id || 'unknown'}: ${ajv.errorsText(validateDefinition.errors)}`);
  }
}
const STYLE_CATALOG = Object.freeze(rawCatalog.styles.map((item) => Object.freeze(structuredClone(item))));
const STYLE_BY_ID = new Map(STYLE_CATALOG.map((item) => [item.id, item]));

export const DEFAULT_RESUME_STYLE = Object.freeze({
  schema_version: 2,
  theme: 'soe-blue-standard',
  density: 'balanced',
  page_budget: 1,
  emphasis: 'general',
  font_family: 'Microsoft YaHei',
  font_size_pt: 9.5,
  page_margin_cm: 1,
  section_order: ['教育经历', '实习与工作经历', '项目经历', '专业技能', '证书与奖项', '校园经历', '基本信息'],
  project_bullet_limit: 4,
  photo: { enabled: false, crop: 'center-3x4', width_cm: 2.4, height_cm: 3.2 },
});

export function migrateResumeStyle(style) {
  if (style?.schema_version !== 1) return structuredClone(style);
  const preset = style.preset;
  return {
    schema_version: 2,
    theme: preset === 'technical-two-page' ? 'technical-minimal' : 'soe-blue-standard',
    density: style.density,
    page_budget: preset === 'technical-two-page' ? 2 : 1,
    emphasis: preset === 'technical-two-page' ? 'technical' : 'general',
    font_family: style.font_family,
    font_size_pt: style.font_size_pt,
    page_margin_cm: style.page_margin_cm,
    section_order: style.section_order,
    project_bullet_limit: style.project_bullet_limit,
    photo: structuredClone(style.photo),
  };
}

export function validateResumeStyle(style) {
  const normalized = migrateResumeStyle(style);
  const errors = [];
  if (!validateSchema(normalized)) {
    errors.push(...(validateSchema.errors || []).map((item) => ({
      code: 'schema_invalid',
      path: item.instancePath || '/',
      message: item.message,
    })));
  }
  if (normalized?.theme && !STYLE_BY_ID.has(normalized.theme)) errors.push({ code: 'unknown_theme', theme: normalized.theme });
  return { valid: errors.length === 0, errors, style: normalized };
}

export function resolveResumeStyleDefinition(styleOrId) {
  const id = typeof styleOrId === 'string' ? styleOrId : styleOrId?.theme;
  const definition = STYLE_BY_ID.get(id);
  if (!definition) {
    const error = new Error(`Unknown resume style theme: ${id || 'missing'}`);
    error.code = 'RESUME_STYLE_THEME_UNKNOWN';
    throw error;
  }
  return structuredClone(definition);
}

export function applyResumeStyleTheme(style, themeId, options = {}) {
  const definition = resolveResumeStyleDefinition(themeId);
  const preserveAxes = options.preserveAxes === true;
  return {
    schema_version: 2,
    theme: definition.id,
    density: preserveAxes ? style.density : definition.defaults.density,
    page_budget: preserveAxes ? style.page_budget : definition.defaults.page_budget,
    emphasis: preserveAxes ? style.emphasis : definition.defaults.emphasis,
    font_family: definition.defaults.font_family,
    font_size_pt: definition.defaults.font_size_pt,
    page_margin_cm: definition.defaults.page_margin_cm,
    section_order: structuredClone(definition.defaults.section_order),
    project_bullet_limit: definition.defaults.project_bullet_limit,
    photo: {
      ...structuredClone(definition.defaults.photo),
      enabled: preserveAxes ? Boolean(style.photo?.enabled) : definition.defaults.photo.enabled,
    },
  };
}

const EMPHASIS_SECTION_ORDER = Object.freeze({
  technical: ['实习与工作经历', '项目经历', '专业技能', '教育经历', '证书与奖项', '校园经历', '基本信息'],
  research: ['教育经历', '项目经历', '实习与工作经历', '证书与奖项', '校园经历', '专业技能', '基本信息'],
  campus: ['教育经历', '校园经历', '实习与工作经历', '项目经历', '证书与奖项', '专业技能', '基本信息'],
});

export function resolveResumeSectionOrder(style) {
  if (style?.emphasis === 'general') return structuredClone(style.section_order);
  return structuredClone(EMPHASIS_SECTION_ORDER[style?.emphasis] || style?.section_order || DEFAULT_RESUME_STYLE.section_order);
}

function factProfile(root) {
  const profile = loadCandidateProfile(root);
  const audit = auditCandidateProfile(root);
  const eligibleIds = new Set(audit.facts.filter((item) => item.eligible).map((item) => item.id));
  const facts = profile.facts.filter((fact) => eligibleIds.has(fact.id));
  const counts = Object.fromEntries([...new Set(facts.map((fact) => fact.type))].map((type) => [type, facts.filter((fact) => fact.type === type).length]));
  return { total: facts.length, counts };
}

function recommendationFromFacts(summary) {
  const count = (type) => summary.counts[type] || 0;
  const technical = count('skill') + count('project') + count('result') + count('quantified_result') + count('internship') + count('employment');
  const academic = count('education') + count('grade') + count('ranking') + count('award') + count('certificate');
  const campus = count('campus') + count('affiliation');
  if (summary.total >= 15 && technical >= 7) {
    return { style_id: 'soe-navy-dense', reasons: [`当前有 ${summary.total} 条可发布 Fact`, `其中 ${technical} 条属于技术、项目或实习结果`, '深蓝紧凑版可在不删除 Fact 的前提下提高一页信息密度'] };
  }
  if (academic >= 5 && campus >= 2) {
    return { style_id: 'soe-red-academic', reasons: [`教育、荣誉与证书类 Fact 共 ${academic} 条`, `校园与组织类 Fact 共 ${campus} 条`, '红色学术版会把教育成果和组织经历放在更清楚的位置'] };
  }
  if (academic >= 4 && technical >= 5 && summary.total >= 12) {
    return { style_id: 'soe-research-formal', reasons: [`学术类 Fact ${academic} 条、技术实践类 Fact ${technical} 条`, '研究与工程内容都较多', '科研综合版默认两页预算，不会通过隐藏 Fact 强压一页'] };
  }
  if (technical >= Math.max(5, academic + campus + 2)) {
    return { style_id: 'technical-minimal', reasons: [`技术、项目与实习类 Fact 共 ${technical} 条`, '技术证据明显多于校园与荣誉内容', '技术极简版优先呈现职责、交付和可验证结果'] };
  }
  return {
    style_id: 'soe-blue-standard',
    reasons: summary.total
      ? [`当前有 ${summary.total} 条可发布 Fact，分布相对均衡`, '蓝色正式版是央国企综合岗位的稳健默认']
      : ['尚无足够的可发布 Fact 用于个性化推荐', '先使用适配面最广的央国企蓝色正式版'],
  };
}

export function getResumeStyleCatalog(root) {
  const fact_summary = factProfile(root);
  return {
    schema_version: 1,
    styles: structuredClone(STYLE_CATALOG),
    editorial_policy: structuredClone(editorialPolicy),
    recommendation: { ...recommendationFromFacts(fact_summary), basis: 'publishable_fact_distribution', fact_summary },
  };
}

export function loadResumeStyle(root) {
  const path = join(root, 'profile', 'resume-style.yml');
  const raw = existsSync(path) ? yaml.load(readFileSync(path, 'utf8')) : structuredClone(DEFAULT_RESUME_STYLE);
  const validation = validateResumeStyle(raw);
  if (!validation.valid) {
    const error = new Error('Resume style profile is invalid');
    error.code = 'RESUME_STYLE_INVALID';
    error.details = validation.errors;
    throw error;
  }
  return validation.style;
}

export function saveResumeStyle(root, style) {
  const validation = validateResumeStyle(style);
  if (!validation.valid) {
    const error = new Error('Resume style profile is invalid');
    error.code = 'RESUME_STYLE_INVALID';
    error.details = validation.errors;
    throw error;
  }
  const path = join(root, 'profile', 'resume-style.yml');
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, yaml.dump(validation.style, { noRefs: true, lineWidth: 120 }), 'utf8');
  renameSync(temporary, path);
  return { style: loadResumeStyle(root), path };
}
