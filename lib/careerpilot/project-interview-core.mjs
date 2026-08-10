import Ajv2020 from 'ajv/dist/2020.js';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateFactEligibility, loadCandidateProfile } from './profile-core.mjs';
import { sha256 } from './hash-core.mjs';

const SYSTEM_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROMPT_VERSION = 'careerpilot-cn-project-interview-v1';
const PROJECT_FACT_ID = /^project\.([a-z0-9_-]+)\.([a-z0-9_-]+)$/;
const VERIFIED_QA_VALUES = ['text_layer', 'render_status', 'truncation', 'overlap', 'whitespace'];
const PACK_CATEGORIES = ['overview', 'ownership', 'architecture', 'mechanism', 'tradeoff', 'reliability'];
// Detect concrete sensitive values, not a safety reminder such as
// “不要输出身份证号码”. Trusted interview context already excludes sensitive
// Facts; this is the final guard against a model fabricating or echoing a value.
const FORBIDDEN_OUTPUT = /(?:\b\d{17}[\dXx]\b|\b1[3-9]\d{9}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:家庭住址|详细住址)[：:]\s*[^，。；;\n]{6,}|(?:家庭成员|父亲|母亲)[：:]\s*[\p{Script=Han}·]{2,20})/iu;
const METRIC_CLAIM = /\d+(?:\.\d+)?\s*(?:%|％|qps|tps|ms|毫秒|秒|分钟|个|人|项|倍|万|千)/giu;
const SOLE_OWNERSHIP_EVIDENCE = /独立(?:完成|负责|设计|实现)|一个人(?:完成|做|负责|设计|实现)|全部由|全程负责|主导全部/u;
const SOLE_OWNERSHIP_CLAIM = /我独立(?:完成|负责|设计|实现)|(?:你|我|本人|候选人)一个人(?:完成|做|负责|设计|实现)|(?:全部|全都|均|都是)(?:由)?(?:我|你|本人|候选人)/u;
const packSchema = JSON.parse(readFileSync(join(SYSTEM_ROOT, 'schemas', 'cn', 'project-interview-pack.schema.json'), 'utf8'));
const validatePackSchema = new Ajv2020({ allErrors: true, strict: true }).compile(packSchema);
const reviewSchema = JSON.parse(readFileSync(join(SYSTEM_ROOT, 'schemas', 'cn', 'project-interview-review.schema.json'), 'utf8'));
const validateReviewSchema = new Ajv2020({ allErrors: true, strict: true }).compile(reviewSchema);

function domainError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function stableSourceId(value) {
  return `export.${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
}

function walkFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function containedFile(root, candidate, boundary) {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  const absolute = resolve(root, candidate);
  const allowedRoot = resolve(root, boundary);
  const rel = relative(allowedRoot, absolute);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  if (!existsSync(absolute)) return null;
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  return absolute;
}

function evidenceForInterview(root, profile) {
  return new Map(profile.evidence.map((item) => {
    const checked = { ...item };
    if (item.sha256 && !/^[a-z][a-z0-9+.-]*:/i.test(item.ref)) {
      const evidencePath = resolve(root, item.ref);
      checked.integrity_valid = existsSync(evidencePath) && sha256(readFileSync(evidencePath)) === item.sha256;
      if (!checked.integrity_valid) checked.integrity_reason = 'hash_mismatch';
    }
    return [item.id, checked];
  }));
}

function readVariant(root, variantId) {
  if (!/^[a-z0-9][a-z0-9._-]+$/.test(String(variantId || ''))) return null;
  const path = join(root, 'profile', 'variants', `${variantId}.json`);
  if (!existsSync(path)) return null;
  try {
    const variant = JSON.parse(readFileSync(path, 'utf8'));
    return variant && typeof variant === 'object' ? variant : null;
  } catch {
    return null;
  }
}

function verifiedExportManifests(root) {
  const outputRoot = join(root, 'output', 'careerpilot');
  const manifests = [];
  for (const path of walkFiles(outputRoot).filter((item) => item.endsWith('.manifest.json'))) {
    try {
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      const output = containedFile(root, manifest.output, join('output', 'careerpilot'));
      if (!output || !['.pdf', '.docx'].includes(extname(output).toLowerCase())) continue;
      if (!/^[a-f0-9]{64}$/.test(String(manifest.content_sha256 || ''))) continue;
      if (sha256(readFileSync(output)) !== manifest.content_sha256) continue;
      if (!manifest.qa || VERIFIED_QA_VALUES.some((key) => manifest.qa[key] !== 'verified')) continue;
      if (!Array.isArray(manifest.fact_ids) || !manifest.fact_ids.length || !manifest.variant_id) continue;
      manifests.push({ manifest, manifestPath: path, output });
    } catch { /* malformed or unrelated artifact */ }
  }
  const latestByVariant = new Map();
  for (const item of manifests) {
    const previous = latestByVariant.get(item.manifest.variant_id);
    if (!previous || String(item.manifest.generated_at || '') > String(previous.manifest.generated_at || '')) {
      latestByVariant.set(item.manifest.variant_id, item);
    }
  }
  return [...latestByVariant.values()].sort((left, right) =>
    String(right.manifest.generated_at || '').localeCompare(String(left.manifest.generated_at || '')));
}

function displayName(summary, slug) {
  const value = String(summary || '').split(/[｜|]/u)[0].trim();
  if (!value) throw domainError('PROJECT_GROUPING_AMBIGUOUS', `项目 ${slug} 缺少可识别的 summary`);
  return value.slice(0, 120);
}

function projectsFromSelection(root, profile, selectedIds, orderedIds, variant) {
  const selected = new Set(selectedIds);
  const order = [...orderedIds.filter((id) => selected.has(id)), ...selectedIds.filter((id) => !orderedIds.includes(id))];
  const factsById = new Map(profile.facts.map((fact) => [fact.id, fact]));
  const evidenceById = evidenceForInterview(root, profile);
  const rewrites = new Map((variant?.rewrites || [])
    .filter((item) => item?.accepted && selected.has(item.fact_id))
    .map((item) => [item.fact_id, String(item.proposed_statement || '').trim()]));
  const groups = new Map();

  for (const factId of order) {
    const match = PROJECT_FACT_ID.exec(factId);
    if (!match) continue;
    const fact = factsById.get(factId);
    if (!fact || fact.type !== 'project' || ['sensitive', 'restricted'].includes(fact.sensitivity)) continue;
    if (!evaluateFactEligibility(fact, evidenceById, 'interview').eligible) continue;
    const [, slug, field] = match;
    if (!groups.has(slug)) groups.set(slug, { id: slug, facts: [] });
    groups.get(slug).facts.push({
      id: fact.id,
      field,
      statement: rewrites.get(fact.id) || fact.statement,
      source_statement: fact.statement,
    });
  }

  return [...groups.values()].map((project) => {
    const summary = project.facts.find((fact) => fact.field === 'summary');
    if (!summary) throw domainError('PROJECT_GROUPING_AMBIGUOUS', `项目 ${project.id} 未包含 summary Fact`);
    return {
      ...project,
      name: displayName(summary.statement, project.id),
      summary: summary.statement,
      fact_count: project.facts.length,
      fact_ids: project.facts.map((fact) => fact.id),
    };
  });
}

function buildInternalSources(root) {
  const profile = loadCandidateProfile(root);
  const sources = [];
  for (const item of verifiedExportManifests(root)) {
    const variant = readVariant(root, item.manifest.variant_id);
    const order = Array.isArray(variant?.order) ? variant.order : item.manifest.fact_ids;
    let projects;
    try {
      projects = projectsFromSelection(root, profile, item.manifest.fact_ids, order, variant);
    } catch (error) {
      if (error?.code === 'PROJECT_GROUPING_AMBIGUOUS') continue;
      throw error;
    }
    if (!projects.length) continue;
    const manifestRelative = relative(root, item.manifestPath).replaceAll('\\', '/');
    sources.push({
      id: stableSourceId(`${manifestRelative}:${item.manifest.content_sha256}`),
      kind: 'verified_export',
      label: basename(item.manifest.output, extname(item.manifest.output)),
      variant_id: item.manifest.variant_id,
      template: item.manifest.template,
      target_job_title: variant?.target_job_title || null,
      generated_at: item.manifest.generated_at,
      manifest: manifestRelative,
      projects,
    });
  }
  return sources;
}

function publicSource(source) {
  const { manifest: _manifest, ...safeSource } = source;
  return {
    ...safeSource,
    projects: source.projects.map(({ facts, ...project }) => project),
  };
}

function interviewInstructions() {
  return [
    readFileSync(join(SYSTEM_ROOT, 'modes', 'cn-campus', '_shared.md'), 'utf8').trim(),
    readFileSync(join(SYSTEM_ROOT, 'modes', 'cn-campus', 'project-interview.md'), 'utf8').trim(),
  ].join('\n\n');
}

export function listProjectInterviewSources(root) {
  const sources = buildInternalSources(root);
  return {
    schema_version: 1,
    default_source_id: sources[0]?.id || null,
    sources: sources.map(publicSource),
  };
}

function trustedContext(root, input) {
  const sources = buildInternalSources(root);
  const source = sources.find((item) => item.id === input?.source_id);
  if (!source) throw domainError('INTERVIEW_RESUME_SOURCE_NOT_FOUND', '未找到可用于面试训练的已验证简历');
  const project = source.projects.find((item) => item.id === input?.project_id);
  if (!project) throw domainError('INTERVIEW_PROJECT_NOT_FOUND', '所选项目不在这份简历中');
  return {
    source: publicSource(source),
    project: {
      id: project.id,
      name: project.name,
      summary: project.summary,
      facts: project.facts.map(({ source_statement, ...fact }) => fact),
    },
  };
}

function cleanTargetRole(value, fallback) {
  const role = String(value || fallback || '目标技术岗位').trim();
  return role.slice(0, 120) || '目标技术岗位';
}

export function buildProjectInterviewPackRequest(root, input) {
  const context = trustedContext(root, input);
  const targetRole = cleanTargetRole(input?.target_role, context.source.target_job_title);
  const instructions = interviewInstructions();
  const outputContract = {
    schema_version: 1,
    phase: 'pack',
    project_id: context.project.id,
    target_role: targetRole,
    analysis: {
      positioning: 'string',
      interviewer_focus: ['string'],
      claim_boundaries: ['string'],
      preparation_priorities: ['string'],
      source_fact_ids: ['project.fact.id'],
    },
    opening_answer: {
      headline: 'string',
      answer: 'string',
      source_fact_ids: ['project.fact.id'],
      unknowns: ['string'],
    },
    questions: [{
      id: 'q1', category: 'overview|ownership|architecture|mechanism|tradeoff|reliability', depth: 'foundation|deep|pressure',
      question: 'string', intent: 'string', scoring_points: ['string'],
      reference_answer: { headline: 'string', points: ['string'], source_fact_ids: ['project.fact.id'], unknowns: ['string'] },
      follow_ups: ['string'],
    }],
  };
  const prompt = [
    instructions,
    `提示词版本：${PROMPT_VERSION}`,
    '本次模式：pack。生成完整项目分析、60 秒开场回答和六道训练题。',
    '输出预算：总正文保持精炼；analysis 的三个列表各 3 项，opening answer 不超过 450 个汉字；每题 scoring_points 3 项、reference_answer.points 3 项、unknowns 最多 2 项、follow_ups 只给 1 项。不要重复同一事实。',
    `目标岗位：${targetRole}`,
    `可信且仅限本项目的事实上下文：\n${JSON.stringify(context.project)}`,
    `只输出符合以下结构的 JSON；字段名和枚举值必须保持不变：\n${JSON.stringify(outputContract)}`,
  ].join('\n\n');
  return { prompt_version: PROMPT_VERSION, prompt, context: { ...context, target_role: targetRole } };
}

function schemaErrors(validator) {
  return (validator.errors || []).map((item) => ({
    code: 'schema_invalid',
    path: item.instancePath || '/',
    message: item.message || 'invalid value',
  }));
}

function referencedFactIds(pack) {
  return [
    ...(pack?.analysis?.source_fact_ids || []),
    ...(pack?.opening_answer?.source_fact_ids || []),
    ...(pack?.questions || []).flatMap((question) => question?.reference_answer?.source_fact_ids || []),
  ];
}

function packClaimText(pack) {
  return [
    pack?.analysis?.positioning,
    ...(pack?.analysis?.interviewer_focus || []),
    ...(pack?.analysis?.preparation_priorities || []),
    pack?.opening_answer?.headline,
    pack?.opening_answer?.answer,
    ...(pack?.questions || []).flatMap((question) => [
      question?.question,
      question?.intent,
      ...(question?.scoring_points || []),
      question?.reference_answer?.headline,
      ...(question?.reference_answer?.points || []),
      ...(question?.follow_ups || []),
    ]),
  ].filter(Boolean).join('\n');
}

function hasUnsupportedSoleOwnership(context, text) {
  const facts = context.project.facts.map((fact) => fact.statement).join('\n');
  return !SOLE_OWNERSHIP_EVIDENCE.test(facts) && SOLE_OWNERSHIP_CLAIM.test(String(text || ''));
}

function normalizeProjectInterviewPack(context, pack) {
  const normalized = structuredClone(pack || {});
  if (!hasUnsupportedSoleOwnership(context, packClaimText(normalized))) return normalized;

  const boundary = '当前已确认事实不足以证明候选人独立完成全部工作；面试回答需说明本人具体责任、可验证贡献与协作边界。';
  const factSummary = context.project.facts.map((fact) => fact.statement).join('；');
  const safeAnswer = `当前可确认的项目事实包括：${factSummary}。${boundary}`;
  const safeQuestion = `请说明你在 ${context.project.name} 中亲自承担的工作、可验证的贡献，以及团队或开源组件的边界。`;
  const replaceClaim = (value, fallback) => SOLE_OWNERSHIP_CLAIM.test(String(value || '')) ? fallback : value;

  if (normalized.analysis) {
    normalized.analysis.positioning = replaceClaim(normalized.analysis.positioning, factSummary);
    for (const key of ['interviewer_focus', 'preparation_priorities']) {
      if (Array.isArray(normalized.analysis[key])) {
        normalized.analysis[key] = normalized.analysis[key].map((value) => replaceClaim(value, boundary));
      }
    }
    if (Array.isArray(normalized.analysis.claim_boundaries) && !normalized.analysis.claim_boundaries.includes(boundary)) {
      normalized.analysis.claim_boundaries = [...normalized.analysis.claim_boundaries.slice(0, 3), boundary];
    }
  }
  if (normalized.opening_answer) {
    normalized.opening_answer.headline = replaceClaim(normalized.opening_answer.headline, '基于已确认事实说明项目与本人责任');
    normalized.opening_answer.answer = replaceClaim(normalized.opening_answer.answer, safeAnswer);
    if (Array.isArray(normalized.opening_answer.unknowns) && !normalized.opening_answer.unknowns.includes(boundary)) {
      normalized.opening_answer.unknowns = [...normalized.opening_answer.unknowns.slice(0, 3), boundary];
    }
  }
  for (const question of normalized.questions || []) {
    question.question = replaceClaim(question.question, safeQuestion);
    question.intent = replaceClaim(question.intent, boundary);
    if (Array.isArray(question.scoring_points)) {
      question.scoring_points = question.scoring_points.map((value) => replaceClaim(value, boundary));
    }
    if (question.reference_answer) {
      question.reference_answer.headline = replaceClaim(question.reference_answer.headline, '基于已确认事实回答');
      if (Array.isArray(question.reference_answer.points)) {
        question.reference_answer.points = question.reference_answer.points.map((value) => replaceClaim(value, boundary));
      }
    }
    if (Array.isArray(question.follow_ups)) {
      question.follow_ups = question.follow_ups.map((value) => replaceClaim(value, safeQuestion));
    }
  }
  return normalized;
}

export function validateProjectInterviewPack(root, input, pack) {
  const errors = [];
  const context = trustedContext(root, input);
  const targetRole = cleanTargetRole(input?.target_role, context.source.target_job_title);
  pack = normalizeProjectInterviewPack(context, pack);
  if (!validatePackSchema(pack)) errors.push(...schemaErrors(validatePackSchema));
  if (pack?.project_id !== context.project.id) {
    errors.push({ code: 'project_mismatch', expected: context.project.id, actual: pack?.project_id });
  }
  if (pack?.target_role !== targetRole) {
    errors.push({ code: 'target_role_mismatch', expected: targetRole, actual: pack?.target_role });
  }
  const allowedFactIds = new Set(context.project.facts.map((fact) => fact.id));
  for (const factId of referencedFactIds(pack)) {
    if (!allowedFactIds.has(factId)) errors.push({ code: 'fact_reference_not_allowed', fact_id: factId });
  }
  const categories = (pack?.questions || []).map((question) => question?.category);
  if (new Set(categories).size !== PACK_CATEGORIES.length || PACK_CATEGORIES.some((category) => !categories.includes(category))) {
    errors.push({ code: 'question_coverage_invalid', expected: PACK_CATEGORIES, actual: categories });
  }
  const questionIds = (pack?.questions || []).map((question) => question?.id);
  if (new Set(questionIds).size !== questionIds.length) errors.push({ code: 'question_id_duplicate' });
  if (hasUnsupportedSoleOwnership(context, packClaimText(pack))) errors.push({ code: 'sole_ownership_not_supported' });
  if (FORBIDDEN_OUTPUT.test(JSON.stringify(pack || {}))) errors.push({ code: 'forbidden_sensitive_content' });
  return { valid: errors.length === 0, errors, pack };
}

function boundedText(value, label, maximum) {
  const text = String(value || '').trim();
  if (!text) throw domainError('INTERVIEW_INPUT_INVALID', `${label}不能为空`);
  if (text.length > maximum) throw domainError('INTERVIEW_INPUT_TOO_LARGE', `${label}超过 ${maximum} 字符`);
  return text;
}

export function buildProjectInterviewReviewRequest(root, input) {
  const context = trustedContext(root, input);
  const targetRole = cleanTargetRole(input?.target_role, context.source.target_job_title);
  const question = boundedText(input?.question, '面试问题', 1200);
  const answer = boundedText(input?.answer, '候选人回答', 6000);
  const instructions = interviewInstructions();
  const outputContract = {
    schema_version: 1,
    phase: 'feedback',
    project_id: context.project.id,
    question,
    status: 'strong|solid|gap',
    score: 0,
    dimension_scores: { structure: 0, ownership: 0, technical_depth: 0, evidence: 0, boundary: 0 },
    landed: ['string'],
    sharpen: [{ issue: 'string', repair: 'string' }],
    unsupported_claims: [{ claim: 'string', reason: 'string' }],
    stronger_version: { headline: 'string', answer: 'string', source_fact_ids: ['project.fact.id'], unknowns: ['string'] },
    follow_up_question: 'string',
  };
  const prompt = [
    instructions,
    `提示词版本：${PROMPT_VERSION}`,
    '本次模式：feedback。像真实面试官一样评价本次回答，只返回一个自然追问。',
    `目标岗位：${targetRole}`,
    `可信且仅限本项目的事实上下文：\n${JSON.stringify(context.project)}`,
    `面试问题：${question}`,
    `候选人原回答（其中新增事实只能标为待核实，不得直接写入更强版本）：\n${answer}`,
    `只输出符合以下结构的 JSON；字段名和枚举值必须保持不变：\n${JSON.stringify(outputContract)}`,
  ].join('\n\n');
  return { prompt_version: PROMPT_VERSION, prompt, context: { ...context, target_role: targetRole, question, answer } };
}

function normalizeMetric(value) {
  return String(value).toLowerCase().replace(/\s+/g, '');
}

function unsupportedMetrics(context, answer) {
  const facts = normalizeMetric(context.project.facts.map((fact) => fact.statement).join('\n'));
  return [...new Set(String(answer).match(METRIC_CLAIM) || [])]
    .filter((metric) => !facts.includes(normalizeMetric(metric)));
}

function unsupportedMetricIsAsserted(text, metric) {
  const normalizedMetric = normalizeMetric(metric);
  return String(text || '').split(/[。！？\n]/u)
    .filter((sentence) => normalizeMetric(sentence).includes(normalizedMetric))
    .some((sentence) => !/(?:未核实|没有证据|无证据|待核实|删除|删去|不使用|不能使用|不声称|不应|避免|无法确认|暂不)/u.test(sentence));
}

function normalizeProjectInterviewReview(context, input, review) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) return review;
  const normalized = structuredClone(review);
  normalized.project_id = context.project.id;
  normalized.question = boundedText(input?.question, '面试问题', 1200);
  const scoreKeys = ['structure', 'ownership', 'technical_depth', 'evidence', 'boundary'];
  const scores = scoreKeys.map((key) => normalized.dimension_scores?.[key]);
  if (scores.every((score) => Number.isInteger(score) && score >= 0 && score <= 20)) {
    normalized.score = scores.reduce((sum, score) => sum + score, 0);
  }
  if (!Array.isArray(normalized.unsupported_claims)) normalized.unsupported_claims = [];
  const knownClaims = normalized.unsupported_claims.map((item) => normalizeMetric(item?.claim));
  for (const metric of unsupportedMetrics(context, input?.answer)) {
    if (knownClaims.some((claim) => claim.includes(normalizeMetric(metric)))) continue;
    normalized.unsupported_claims.push({
      claim: metric,
      reason: '当前项目 Fact 未包含该指标，正式面试前需要补充证据',
    });
  }
  return normalized;
}

export function validateProjectInterviewReview(root, input, review) {
  const errors = [];
  const context = trustedContext(root, input);
  const question = boundedText(input?.question, '面试问题', 1200);
  const answer = boundedText(input?.answer, '候选人回答', 6000);
  review = normalizeProjectInterviewReview(context, input, review);
  if (!validateReviewSchema(review)) errors.push(...schemaErrors(validateReviewSchema));
  if (review?.project_id !== context.project.id) {
    errors.push({ code: 'project_mismatch', expected: context.project.id, actual: review?.project_id });
  }
  if (review?.question !== question) errors.push({ code: 'question_mismatch' });
  const allowedFactIds = new Set(context.project.facts.map((fact) => fact.id));
  for (const factId of review?.stronger_version?.source_fact_ids || []) {
    if (!allowedFactIds.has(factId)) errors.push({ code: 'fact_reference_not_allowed', fact_id: factId });
  }
  for (const metric of unsupportedMetrics(context, answer)) {
    const claims = (review?.unsupported_claims || []).map((item) => normalizeMetric(item.claim));
    if (!claims.some((claim) => claim.includes(normalizeMetric(metric)))) {
      errors.push({ code: 'unsupported_claim_not_flagged', claim: metric });
    }
    if (unsupportedMetricIsAsserted(review?.stronger_version?.answer, metric)) {
      errors.push({ code: 'unsupported_claim_reused', claim: metric });
    }
  }
  if (hasUnsupportedSoleOwnership(context, [
    review?.stronger_version?.headline,
    review?.stronger_version?.answer,
  ].filter(Boolean).join('\n'))) {
    errors.push({ code: 'sole_ownership_not_supported' });
  }
  if (FORBIDDEN_OUTPUT.test(JSON.stringify(review || {}))) errors.push({ code: 'forbidden_sensitive_content' });
  return { valid: errors.length === 0, errors, review };
}
