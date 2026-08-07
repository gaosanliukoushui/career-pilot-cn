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
const contentStrategies = JSON.parse(readFileSync(join(ROOT, 'templates', 'cn', 'resume-content-strategies.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);
const validateDefinition = ajv.compile(definitionSchema);

for (const definition of rawCatalog.styles || []) {
  if (!validateDefinition(definition)) {
    throw new Error(`Invalid ResumeStyleDefinition ${definition?.id || 'unknown'}: ${ajv.errorsText(validateDefinition.errors)}`);
  }
  if (definition.content_strategy_id !== definition.id) {
    throw new Error(`ResumeStyleDefinition ${definition.id} must use the matching content strategy`);
  }
}
const strategyIds = new Set((contentStrategies.strategies || []).map((item) => item.id));
if (contentStrategies.schema_version !== 1 || strategyIds.size !== 3 || rawCatalog.styles.some((item) => !strategyIds.has(item.content_strategy_id))) {
  throw new Error('Invalid resume content strategy catalog');
}
const STYLE_CATALOG = Object.freeze(rawCatalog.styles.map((item) => Object.freeze(structuredClone(item))));
const STYLE_BY_ID = new Map(STYLE_CATALOG.map((item) => [item.id, item]));

export const DEFAULT_RESUME_STYLE = Object.freeze({
  schema_version: 2,
  theme: 'soe-outcome',
  density: 'balanced',
  page_budget: 1,
  emphasis: 'general',
  font_family: 'Microsoft YaHei',
  font_size_pt: 9.5,
  page_margin_cm: 1,
  section_order: ['教育经历', '实习与工作经历', '项目经历', '校园经历', '证书与奖项', '专业技能', '基本信息'],
  project_bullet_limit: 3,
  photo: { enabled: false, crop: 'center-3x4', width_cm: 2.4, height_cm: 3.2 },
});

const LEGACY_THEME_MAP = Object.freeze({
  'compact-photo': 'soe-outcome',
  'compact-no-photo': 'soe-outcome',
  'technical-two-page': 'internet-engineering',
  'soe-blue-standard': 'soe-outcome',
  'soe-navy-dense': 'soe-outcome',
  'soe-red-academic': 'research-academic',
  'soe-research-formal': 'research-academic',
  'technical-minimal': 'internet-engineering',
});

export function migrateResumeStyle(style) {
  if (style?.schema_version === 1) {
    const preset = style.preset;
    return {
      schema_version: 2,
      theme: LEGACY_THEME_MAP[preset] || 'soe-outcome',
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
  const migrated = structuredClone(style);
  if (migrated?.schema_version === 2 && LEGACY_THEME_MAP[migrated.theme]) {
    migrated.theme = LEGACY_THEME_MAP[migrated.theme];
  }
  return migrated;
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
  return { total: facts.length, counts, facts };
}

function recommendationFromFacts(summary) {
  const count = (type) => summary.counts[type] || 0;
  const research = count('publication') + count('patent') + count('research') + count('thesis');
  if (research >= 2) {
    return {
      style_id: 'research-academic',
      reasons: [`当前有 ${research} 条论文、专利或研究类可发布 Fact`, '科研策略会突出研究问题、方法、个人贡献与证据化成果', '目标单位仍需由用户确认；策略不会把课程或工具名称当作科研成果'],
    };
  }
  return {
    style_id: 'soe-outcome',
    reasons: summary.total
      ? [`当前有 ${summary.total} 条可发布 Fact`, '在尚未绑定目标单位招聘语境时，默认先用央国企成果导向', '互联网工程策略需要由目标岗位和阅读者语境确认，不能只按技术 Fact 数量猜测']
      : ['尚无足够的可发布 Fact 用于个性化推荐', '先使用央国企成果导向，再随目标单位与岗位切换'],
  };
}

function contentAudit(summary) {
  const experienceTypes = new Set(['internship', 'employment', 'project', 'campus', 'affiliation']);
  const resultTypes = new Set(['result', 'quantified_result']);
  const experienceFactCount = summary.facts.filter((fact) => experienceTypes.has(fact.type)).length;
  const resultFactCount = summary.facts.filter((fact) => resultTypes.has(fact.type)).length;
  const resultCoverageProxy = experienceFactCount ? Number((resultFactCount / experienceFactCount).toFixed(3)) : 0;
  const guidance = [
    `当前共有 ${experienceFactCount} 条经历类 Fact、${resultFactCount} 条独立结果类 Fact；该比例只用于组合层诊断，不代表逐条经历已经具备结果。`,
    '系统不会编造缺失结果；需要补充并确认 Evidence 后，结果才可进入正式简历。',
  ];
  if (experienceFactCount && resultFactCount < experienceFactCount) {
    guidance.push('优先回看实习、项目和校园经历，确认是否存在交付、验收、稳定运行、风险消除或流程闭环等非量化结果。');
  }
  return {
    experience_fact_count: experienceFactCount,
    result_fact_count: resultFactCount,
    result_coverage_proxy: resultCoverageProxy,
    inference_boundary: 'portfolio_level_proxy_not_fact_rewrite',
    guidance,
  };
}

export function getResumeStyleCatalog(root) {
  const profile = factProfile(root);
  const fact_summary = { total: profile.total, counts: profile.counts };
  return {
    schema_version: 2,
    styles: structuredClone(STYLE_CATALOG),
    editorial_policy: structuredClone(editorialPolicy),
    content_strategies: structuredClone(contentStrategies),
    content_audit: contentAudit(profile),
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
