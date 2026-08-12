import Ajv2020 from 'ajv/dist/2020.js';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { containsForbiddenResumeStatement, evaluateFactEligibility, loadCandidateProfile } from './profile-core.mjs';
import { sha256 } from './hash-core.mjs';
import { validateResumeVariant } from './resume-core.mjs';
import { verifyRenderedResumePdf } from './artifact-qa-core.mjs';
import { validateResumeArtifactManifest } from './artifact-core.mjs';

const SYSTEM_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROMPT_VERSION = 'careerpilot-cn-project-interview-v3';
const PROJECT_FACT_ID = /^project\.([a-z0-9_-]+)\.([a-z0-9_-]+)$/;
const VERIFIED_QA_VALUES = ['text_layer', 'render_status', 'truncation', 'overlap', 'whitespace'];
const PACK_CATEGORIES = ['overview', 'ownership', 'architecture', 'mechanism', 'tradeoff', 'reliability'];
const PACK_DEPTHS = ['foundation', 'foundation', 'deep', 'deep', 'deep', 'pressure'];
// Detect concrete sensitive values, not a safety reminder such as
// “不要输出身份证号码”. Trusted interview context already excludes sensitive
// Facts; this is the final guard against a model fabricating or echoing a value.
const FORBIDDEN_OUTPUT = /(?:\b\d{17}[\dXx]\b|\b1[3-9]\d{9}\b|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:联系地址|家庭住址|详细住址|现住址|地址)(?:是|为|[：:])\s*[^，。；;\n]{6,}|(?:家庭成员|父亲|母亲|配偶|子女)(?:姓名|是|为|[：:])\s*[\p{Script=Han}·]{2,20}|(?:电话|座机|联系方式|微信|wechat|qq)(?:号码|是|为|[：:])\s*[+\dA-Z][\dA-Z _-]{5,30})/iu;
const METRIC_CLAIM = /\d+(?:\.\d+)?\s*(?:%|％|qps|tps|ms|毫秒|秒|分钟|个|人|项|倍|万|千)/giu;
const OWNERSHIP_CLAIM = /(?:独立|主导|全权|全部负责|从零完成|owned?|led|solely|entire)/iu;
const NEGATED_ACTION = /(?:并非|不是|不由|未曾|未参与|未负责|未实现|没有|从未|not|never|didn't|did not)/iu;
const EXPLICIT_RESPONSIBILITY_ACTION = /(?:参与|负责|主导|独立|协助|配合|本人|个人|owned?|led|solely)/iu;
const RESPONSIBILITY_ACTION = /(?:参与|负责|主导|独立|协助|配合|构建|开发|实现|搭建|设计|完成|补充|接入|改造|built?|implemented?|developed?|owned?|led)/iu;
const SOLUTION_ACTION = /(?:基于|通过|采用|使用|接入|实现|构建|开发|搭建|设计|拆分|引入|补充|支持|限制|覆盖|built?|implemented?|developed?|using|with)/iu;
const VALIDATION_ACTION = /(?:测试|验收|验证|评估|压测|smoke|testcontainers|jmeter|报告|质量|幂等|冲突|失败|恢复|重试|审计|eval|benchmark)/iu;
const FACTUAL_ACTION_CLAIM = /(?:参与|负责|主导|独立|协助|配合|构建|开发|实现|搭建|设计|完成|补充|接入|改造|基于|通过|采用|使用|引入|支持|限制|覆盖|测试|验收|验证|评估|压测|上线|部署|提升|降低|解决|built?|implemented?|developed?|owned?|led|using|deployed?|improved?|reduced?)/iu;
const OWNERSHIP_BOUNDARY = '本人责任、团队贡献与开源组件边界必须逐字沿用上方 Fact；任何未被 Fact 明确覆盖的归属仍需本人核实。';
const CONTENT_NEUTRAL_VARIANT_ERRORS = new Set(['resume_style_changed_since_preview']);
const INTERVIEW_FACT_MAX = 4_000;
const schemaValidators = new Map();

function containsForbiddenSensitiveContent(value) {
  const text = String(value || '');
  return containsForbiddenResumeStatement(text) || FORBIDDEN_OUTPUT.test(text);
}

function domainError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function readRequiredSystemText(parts, label) {
  const path = join(SYSTEM_ROOT, ...parts);
  if (!existsSync(path)) throw domainError('INTERVIEW_SYSTEM_FILE_MISSING', `${label}缺失`);
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw domainError('INTERVIEW_SYSTEM_FILE_UNREADABLE', `${label}无法读取`, { cause: error?.message });
  }
}

function readRequiredSystemJson(parts, label) {
  try {
    return JSON.parse(readRequiredSystemText(parts, label));
  } catch (error) {
    if (error?.code?.startsWith?.('INTERVIEW_SYSTEM_FILE_')) throw error;
    throw domainError('INTERVIEW_SYSTEM_FILE_INVALID', `${label}不是有效 JSON`, { cause: error?.message });
  }
}

function compileSystemSchema(schema, label) {
  try {
    return new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  } catch (error) {
    throw domainError('INTERVIEW_SYSTEM_FILE_INVALID', `${label}无法编译`, { cause: error?.message });
  }
}

function systemSchemaValidator(parts, label) {
  const key = parts.join('/');
  if (!schemaValidators.has(key)) {
    schemaValidators.set(key, compileSystemSchema(readRequiredSystemJson(parts, label), label));
  }
  return schemaValidators.get(key);
}

function exactFactRefSchema(facts) {
  const refs = uniqueFacts(facts).map((fact) => ({ fact_id: fact.id, fact_sha256: fact.statement_sha256 }));
  return refs.length ? { enum: refs } : { not: {} };
}

function boundedFactRefsSchema(facts, maximum = 3, minimum = 0) {
  const available = uniqueFacts(facts);
  return {
    type: 'array',
    minItems: Math.min(minimum, available.length),
    maxItems: Math.min(maximum, available.length),
    uniqueItems: true,
    items: exactFactRefSchema(available),
  };
}

function dynamicPackProposalSchema(context, targetRole) {
  const base = structuredClone(readRequiredSystemJson(
    ['schemas', 'cn', 'project-interview-pack-proposal.schema.json'],
    '项目面试训练包计划 Schema',
  ));
  base.properties.project_id = { const: context.project.id };
  base.properties.target_role = { const: targetRole };
  base.properties.analysis_facts = boundedFactRefsSchema(context.project.facts, 4, 1);
  base.properties.opening_sections = {
    type: 'array',
    minItems: ANSWER_STAGES.length,
    maxItems: ANSWER_STAGES.length,
    prefixItems: ANSWER_STAGES.map(([stage]) => {
      const candidates = context.project.facts.filter((fact) => factSupportsStage(fact, stage));
      return {
        type: 'object',
        additionalProperties: false,
        required: ['stage', 'fact', 'verification_topic'],
        properties: {
          stage: { const: stage },
          fact: { anyOf: [exactFactRefSchema(candidates), { type: 'null' }] },
          verification_topic: {
            anyOf: [
              { enum: ['responsibility', 'implementation', 'tradeoff', 'validation', 'collaboration', 'production_status'] },
              { type: 'null' },
            ],
          },
        },
        oneOf: [
          { properties: { fact: exactFactRefSchema(candidates), verification_topic: { type: 'null' } } },
          {
            properties: {
              fact: { type: 'null' },
              verification_topic: { enum: ['responsibility', 'implementation', 'tradeoff', 'validation', 'collaboration', 'production_status'] },
            },
          },
        ],
      };
    }),
    items: false,
  };
  base.properties.questions = {
    type: 'array',
    minItems: PACK_CATEGORIES.length,
    maxItems: PACK_CATEGORIES.length,
    prefixItems: PACK_CATEGORIES.map((category, index) => {
      const stage = CATEGORY_STAGE[category];
      const candidates = context.project.facts.filter((fact) => factSupportsStage(fact, stage));
      return {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'category', 'depth', 'answer_facts', 'unknown_topics'],
        properties: {
          id: { const: `q${index + 1}` },
          category: { const: category },
          depth: { const: PACK_DEPTHS[index] },
          answer_facts: boundedFactRefsSchema(candidates, 3),
          unknown_topics: {
            type: 'array',
            maxItems: 2,
            uniqueItems: true,
            items: { enum: ['responsibility', 'implementation', 'tradeoff', 'validation', 'collaboration', 'production_status'] },
          },
        },
      };
    }),
    items: false,
  };
  return base;
}

function packSelectionMatrix(context) {
  const refsForStage = (stage) => context.project.facts
    .filter((fact) => factSupportsStage(fact, stage))
    .map((fact) => ({ fact_id: fact.id, fact_sha256: fact.statement_sha256 }));
  return {
    opening_sections: Object.fromEntries(ANSWER_STAGES.map(([stage]) => [stage, refsForStage(stage)])),
    questions: PACK_CATEGORIES.map((category, index) => ({
      id: `q${index + 1}`,
      category,
      depth: PACK_DEPTHS[index],
      answer_fact_candidates: refsForStage(CATEGORY_STAGE[category]),
    })),
  };
}

function dynamicReviewProposalSchema(context, questionHash, answerHash) {
  const base = structuredClone(readRequiredSystemJson(
    ['schemas', 'cn', 'project-interview-review-proposal.schema.json'],
    '项目面试点评计划 Schema',
  ));
  base.properties.project_id = { const: context.project.id };
  base.properties.question_sha256 = { const: questionHash };
  base.properties.answer_sha256 = { const: answerHash };
  base.properties.stronger_fact_refs = boundedFactRefsSchema(context.project.facts, 6, 1);
  return base;
}

function stableSourceId(value) {
  return `export.${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
}

function walkFiles(directory) {
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) return [];
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
  if (!existsSync(allowedRoot) || lstatSync(allowedRoot).isSymbolicLink() || !lstatSync(allowedRoot).isDirectory() || !existsSync(absolute)) return null;
  const rel = relative(realpathSync(allowedRoot), realpathSync(absolute));
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
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
  const validateManifest = systemSchemaValidator(
    ['schemas', 'cn', 'project-interview-source-manifest.schema.json'],
    '项目面试简历来源 manifest Schema',
  );
  for (const path of walkFiles(outputRoot).filter((item) => item.endsWith('.manifest.json'))) {
    try {
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      if (!validateManifest(manifest)) continue;
      if (manifest.schema_version === 2 && !validateResumeArtifactManifest(manifest).valid) continue;
      const output = containedFile(root, manifest.output, join('output', 'careerpilot'));
      if (!output || !['.pdf', '.docx'].includes(extname(output).toLowerCase())) continue;
      if (sha256(readFileSync(output)) !== manifest.content_sha256) continue;
      if (VERIFIED_QA_VALUES.some((key) => manifest.qa[key] !== 'verified')) continue;
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
    const statement = rewrites.get(fact.id) || fact.statement;
    if (String(statement || '').length > INTERVIEW_FACT_MAX) continue;
    if (containsForbiddenSensitiveContent(fact.statement) || containsForbiddenSensitiveContent(statement)) continue;
    const [, slug, field] = match;
    if (!groups.has(slug)) groups.set(slug, { id: slug, facts: [] });
    groups.get(slug).facts.push({
      id: fact.id,
      field,
      statement,
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

async function buildInternalSources(root) {
  const profile = loadCandidateProfile(root);
  const sources = [];
  for (const item of verifiedExportManifests(root)) {
    const variant = readVariant(root, item.manifest.variant_id);
    if (!variant || !['ready', 'exported'].includes(variant.status)) continue;
    const variantValidation = validateResumeVariant(root, variant);
    if (variantValidation.errors.some((error) => !CONTENT_NEUTRAL_VARIANT_ERRORS.has(error.code))) continue;
    if (item.manifest.template !== variant.template) continue;
    if (JSON.stringify(item.manifest.fact_ids) !== JSON.stringify(variant.fact_ids)) continue;
    const manifestConfirmation = item.manifest.variant_confirmation_sha256;
    if (manifestConfirmation) {
      if (manifestConfirmation !== variant.confirmation?.preview_sha256) continue;
    } else {
      const generatedAt = Date.parse(item.manifest.generated_at);
      const confirmedAt = Date.parse(variant.confirmation?.confirmed_at || '');
      if (!Number.isFinite(generatedAt) || !Number.isFinite(confirmedAt) || generatedAt < confirmedAt) continue;
    }
    const order = variant.order;
    let projects;
    try {
      projects = projectsFromSelection(root, profile, item.manifest.fact_ids, order, variant);
    } catch (error) {
      if (error?.code === 'PROJECT_GROUPING_AMBIGUOUS') continue;
      throw error;
    }
    if (!projects.length) continue;
    if (!manifestConfirmation) {
      // Legacy v1 exports did not bind the exact confirmation/rewrite hash.
      // Re-verify every Fact used for interview training against the immutable
      // PDF text layer; DOCX-only legacy artifacts stay unavailable until the
      // user creates a newly bound export.
      if (extname(item.output).toLowerCase() !== '.pdf') continue;
      try {
        await verifyRenderedResumePdf(item.output, {
          pageBudget: Number(item.manifest.qa.page_budget || item.manifest.qa.page_count || 10),
          minimumVerticalFill: 0,
          expectedStatements: projects.flatMap((project) => project.facts.map((fact) => fact.statement)),
          exactStatementSequences: [
            '专业技能', '证书与奖项', '校园经历', '实习与工作经历', '基本信息', '个人概述', '教育经历',
          ].map((ending) => [
            '项目经历',
            ...projects.flatMap((project) => project.facts.map((fact) => fact.statement)),
            ending,
          ]),
        });
      } catch {
        continue;
      }
    }
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
    readRequiredSystemText(['modes', 'cn-campus', '_shared.md'], '校园求职共享规则').trim(),
    readRequiredSystemText(['modes', 'cn-campus', 'project-interview.md'], '项目面试提示词').trim(),
  ].join('\n\n');
}

export async function listProjectInterviewSources(root) {
  const sources = await buildInternalSources(root);
  return {
    schema_version: 1,
    default_source_id: sources[0]?.id || null,
    sources: sources.map(publicSource),
  };
}

async function trustedContext(root, input) {
  const sources = await buildInternalSources(root);
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
      facts: project.facts.map(({ source_statement, ...fact }) => ({
        ...fact,
        statement_sha256: sha256(Buffer.from(fact.statement, 'utf8')),
      })),
    },
  };
}

function cleanTargetRole(value, fallback) {
  const role = String(value || fallback || '目标技术岗位').trim();
  return role.slice(0, 120) || '目标技术岗位';
}

export async function buildProjectInterviewPackRequest(root, input) {
  const context = await trustedContext(root, input);
  const targetRole = cleanTargetRole(input?.target_role, context.source.target_job_title);
  if (containsForbiddenSensitiveContent(targetRole)) {
    throw domainError('INTERVIEW_INPUT_FORBIDDEN', '目标岗位包含不应发送给模型的具体身份或联系信息');
  }
  const instructions = interviewInstructions();
  const proposalSchema = dynamicPackProposalSchema(context, targetRole);
  const selectionMatrix = packSelectionMatrix(context);
  const outputContract = {
    schema_version: 1,
    phase: 'pack_plan',
    project_id: context.project.id,
    target_role: targetRole,
    analysis_facts: [{ fact_id: 'project.fact.id', fact_sha256: 'copy the supplied statement_sha256 exactly' }],
    opening_sections: [{
      stage: 'scenario|responsibility|solution|validation',
      fact: { fact_id: 'project.fact.id', fact_sha256: 'copy the supplied statement_sha256 exactly' },
      verification_topic: null,
    }],
    questions: [{
      id: 'q1',
      category: 'overview|ownership|architecture|mechanism|tradeoff|reliability',
      depth: 'foundation|deep|pressure',
      answer_facts: [],
      unknown_topics: ['responsibility|implementation|tradeoff|validation|collaboration|production_status'],
    }],
  };
  const prompt = [
    instructions,
    `提示词版本：${PROMPT_VERSION}`,
    '本次模式：pack_plan。你只做 Fact 选择、排序、题型深度与待核实主题规划，不生成候选人事实性散文。',
    '必须原样复制所选 Fact 的 fact_id 与 statement_sha256。服务端会重算哈希，并用完整 Fact 原文或已确认 rewrite 渲染分析、参考回答和问题；你无法提供任意连接词或新主张。',
    '输出 Schema 已锁定项目、岗位、六题的题号/题型/深度，以及每个阶段可选的 Fact ID+哈希。不得改变固定值，也不得在其他阶段复用 Fact；没有合法候选时返回空数组或选择复核主题。',
    'opening_sections 必须按 scenario、responsibility、solution、validation 顺序各出现一次。Fact 明确支持该阶段时填写 fact 且 verification_topic=null；否则 fact=null 并选择一个中性的复核主题。每题 answer_facts 选择 0–3 条可直接支撑该题的 Fact；没有语义匹配的 Fact 时必须返回空数组，不能为了凑数错配。',
    `固定结构与合法 Fact 选择矩阵（只能从对应数组原样复制；空数组必须返回 fact=null 或 answer_facts=[]）：\n${JSON.stringify(selectionMatrix)}`,
    `目标岗位：${targetRole}`,
    `可信且仅限本项目的事实上下文：\n${JSON.stringify(context.project)}`,
    `只输出符合以下结构的 JSON；字段名和枚举值必须保持不变：\n${JSON.stringify(outputContract)}`,
  ].join('\n\n');
  return { prompt_version: PROMPT_VERSION, prompt, proposal_schema: proposalSchema, context: { ...context, target_role: targetRole } };
}

function schemaErrors(validator) {
  return (validator.errors || []).map((item) => ({
    code: 'schema_invalid',
    path: item.instancePath || '/',
    message: item.message || 'invalid value',
  }));
}

const UNKNOWN_TOPIC_TEXT = {
  responsibility: '建议复核：面试前准备本人具体责任及对应 Fact，不从项目类型推导归属',
  implementation: '建议复核：只讲 Fact 已覆盖的实现细节，其余调用链需补证',
  tradeoff: '建议复核：准备候选方案、选择理由与代价的原始证据',
  validation: '建议复核：准备测试、验收或可复现的验证证据',
  collaboration: '建议复核：逐字对齐团队、开源组件与本人工作的边界',
  production_status: '建议复核：按 Fact 原文说明运行状态，并准备对应证据',
};

const ANSWER_STAGES = [
  ['scenario', '场景与问题'],
  ['responsibility', '本人责任'],
  ['solution', '方案与取舍'],
  ['validation', '验证'],
];

const CATEGORY_STAGE = {
  overview: 'scenario',
  ownership: 'responsibility',
  architecture: 'solution',
  mechanism: 'solution',
  tradeoff: 'solution',
  reliability: 'validation',
};

function factSupportsStage(fact, stage) {
  const field = String(fact?.field || '').toLowerCase();
  const statement = String(fact?.statement || '');
  if (stage === 'scenario') return field === 'summary';
  if (NEGATED_ACTION.test(statement)) return false;
  if (stage === 'responsibility') return RESPONSIBILITY_ACTION.test(statement);
  if (stage === 'solution') return field !== 'summary' && SOLUTION_ACTION.test(statement);
  if (stage === 'validation') return /(?:quality|eval|test|validation|reliability|result|metric)/iu.test(field)
    || VALIDATION_ACTION.test(statement);
  return false;
}

const QUESTION_TEMPLATES = {
  overview: {
    question: (name, anchor) => anchor
      ? `请结合${anchor}介绍 ${name}：它解决什么问题，这条 Fact 能证明什么，哪些信息仍需本人核实？`
      : `请只基于已确认 Fact 介绍 ${name}：它解决什么问题，哪些信息仍需本人核实？`,
    intent: '核验候选人能否区分简历已确认事实与尚未提供的细节。',
    followUp: '请选择一条已确认 Fact，说明它能证明什么、不能证明什么。',
  },
  ownership: {
    question: (name, anchor) => anchor
      ? `围绕${anchor}，请说明你在 ${name} 中能被证明的本人工作，并区分团队工作与开源组件；Fact 没写的部分不要推断。`
      : `在 ${name} 中，请逐项区分已确认的本人工作、团队工作与开源组件；Fact 没写的部分不要推断。`,
    intent: '核验责任归属是否与简历 Fact 一致。',
    followUp: '哪一条已确认 Fact 最能支持你对本人责任的表述？还缺什么证据？',
  },
  architecture: {
    question: (name, anchor) => anchor
      ? `请从${anchor}出发说明 ${name} 的相关结构或调用链；对 Fact 未出现的组件明确回答“待核实”。`
      : `请基于 ${name} 当前已确认 Fact 说明系统结构；对未出现的组件明确回答“待核实”。`,
    intent: '考察架构表达与事实边界，不预设任何具体组件。',
    followUp: '如果不能补充新组件，你会如何用现有 Fact 解释关键链路？',
  },
  mechanism: {
    question: (name, anchor) => anchor
      ? `请围绕${anchor}讲清 ${name} 中能被证明的技术机制；实现细节不足时请直接标记待核实。`
      : `请从 ${name} 的一条已确认 Fact 出发，说明你能证明的机制；实现细节不足时请直接标记待核实。`,
    intent: '考察技术深度，同时防止把外部知识冒充成个人经历。',
    followUp: '你需要补充哪项原始证据，才能继续讲深这条机制？',
  },
  tradeoff: {
    question: (name, anchor) => anchor
      ? `针对${anchor}，请区分 ${name} 中“Fact 已证明的选择”与“面试前还需核实的取舍”。`
      : `围绕 ${name}，请区分“Fact 已证明的选择”与“面试前还需核实的取舍”。`,
    intent: '考察方案取舍能力，不允许从技术名称自动推导实际选型过程。',
    followUp: '如果取舍理由未写入 Fact，你会在面试前准备哪些可验证材料？',
  },
  reliability: {
    question: (name, anchor) => anchor
      ? `请结合${anchor}说明 ${name} 中已证明的测试、失败处理或运行边界；缺失的上线与效果信息必须标记待核实。`
      : `请基于 ${name} 已确认 Fact 说明测试、失败处理或运行边界；缺失的上线与效果信息必须标记待核实。`,
    intent: '考察验证与可靠性意识，不从“没写上线”推导“尚未上线”。',
    followUp: '现有 Fact 还不能证明哪个可靠性结论？你要如何补证？',
  },
};

function factQuestionAnchor(facts) {
  const fact = uniqueFacts(facts)[0];
  if (!fact) return null;
  const firstClause = String(fact.statement || '').split(/[。；;\n]/u)[0].trim();
  return firstClause && firstClause.length <= 120
    ? `简历 Fact「${firstClause}」`
    : `简历 Fact ${fact.id}`;
}

function factFocusItems(facts) {
  const selected = uniqueFacts(facts).slice(0, 3);
  if (!selected.length) return ['核验简历 Fact 能证明的项目问题、本人责任与验证边界'];
  return selected.map((fact) => `围绕${factQuestionAnchor([fact])}追问它能证明什么、不能证明什么`);
}

function factByRef(context, ref, path, errors) {
  const fact = context.project.facts.find((item) => item.id === ref?.fact_id);
  if (!fact) {
    errors.push({ code: 'fact_reference_not_allowed', path, fact_id: ref?.fact_id });
    return null;
  }
  if (ref?.fact_sha256 !== fact.statement_sha256) {
    errors.push({ code: 'fact_hash_mismatch', path, fact_id: fact.id, expected: fact.statement_sha256, actual: ref?.fact_sha256 });
    return null;
  }
  return fact;
}

function uniqueFacts(facts) {
  return [...new Map(facts.filter(Boolean).map((fact) => [fact.id, fact])).values()];
}

function renderStage(label, facts, missingText) {
  return facts.length
    ? [`【${label}】`, ...facts.map((fact) => fact.statement)].join('\n')
    : `【${label}】${missingText}`;
}

function stageReferenceAnswer(context, category, facts) {
  const selectedStage = CATEGORY_STAGE[category];
  const summary = context.project.facts.find((fact) => factSupportsStage(fact, 'scenario'));
  const byStage = Object.fromEntries(ANSWER_STAGES.map(([stage]) => [stage, []]));
  if (summary) byStage.scenario.push(summary);
  for (const fact of facts) {
    if (factSupportsStage(fact, selectedStage)) byStage[selectedStage].push(fact);
  }
  const sourceFacts = uniqueFacts(Object.values(byStage).flat());
  return {
    points: [
      renderStage('场景与问题', uniqueFacts(byStage.scenario), '当前正式简历未提供可直接复述的项目场景，面试前需本人复核。'),
      renderStage('本人责任', uniqueFacts(byStage.responsibility), '本题引用的 Fact 未明确本人动作，不能从“个人项目”或“团队项目”推导责任。'),
      renderStage('方案与取舍', uniqueFacts(byStage.solution), '本题引用的 Fact 未明确可复述方案；选择理由与代价需本人补证。'),
      renderStage('验证', uniqueFacts(byStage.validation), '本题引用的 Fact 未明确测试、指标或运行证据，面试前需本人复核。'),
      `【边界】${OWNERSHIP_BOUNDARY}未被引用 Fact 覆盖的指标、技术栈、实现细节、因果关系与结果均不得补造。`,
    ],
    sourceFacts,
  };
}

function directFiveStageAnswer(facts) {
  const selected = uniqueFacts(facts);
  const byStage = Object.fromEntries(ANSWER_STAGES.map(([stage]) => [stage, []]));
  for (const fact of selected) {
    let stage = null;
    if (factSupportsStage(fact, 'scenario')) stage = 'scenario';
    else if (factSupportsStage(fact, 'validation')) stage = 'validation';
    else if (EXPLICIT_RESPONSIBILITY_ACTION.test(fact.statement) && factSupportsStage(fact, 'responsibility')) stage = 'responsibility';
    else if (factSupportsStage(fact, 'solution')) stage = 'solution';
    else if (factSupportsStage(fact, 'responsibility')) stage = 'responsibility';
    if (stage && byStage[stage].length < 2) byStage[stage].push(fact);
  }
  const sourceFacts = uniqueFacts(Object.values(byStage).flat());
  return {
    answer: [
      renderStage('场景与问题', byStage.scenario, '所选 Fact 未提供可直接复述的项目场景，面试前需本人复核。'),
      renderStage('本人责任', byStage.responsibility, '所选 Fact 未明确本人动作，不能从项目类型推导责任。'),
      renderStage('方案与取舍', byStage.solution, '所选 Fact 未明确可复述方案，选择理由与代价需本人补证。'),
      renderStage('验证', byStage.validation, '所选 Fact 未明确测试、指标或运行证据，面试前需本人复核。'),
      `【边界】${OWNERSHIP_BOUNDARY}未被引用 Fact 覆盖的指标、技术栈、实现细节、因果关系与结果均不得补造。`,
    ].join('\n'),
    sourceFacts: sourceFacts.length ? sourceFacts : selected,
  };
}

function renderPackFromPlan(context, targetRole, plan, resolved) {
  const analysisFacts = resolved.analysis;
  const openingFacts = uniqueFacts(resolved.opening.filter((item) => item.fact).map((item) => item.fact));
  return {
    schema_version: 1,
    phase: 'pack',
    project_id: context.project.id,
    target_role: targetRole,
    analysis: {
      positioning: [
        '【AI 从正式简历中选出的项目定位依据；各行独立】',
        ...analysisFacts.map((fact) => fact.statement),
      ].join('\n'),
      interviewer_focus: factFocusItems(analysisFacts),
      claim_boundaries: ['不从多条 Fact 自动推导因果关系', '不把项目类型改写为个人独立归属', '未被 Fact 覆盖的实现、指标与上线状态一律待核实'],
      preparation_priorities: analysisFacts.slice(0, 3).map((fact) => `为${factQuestionAnchor([fact])}准备证据、本人责任和可复述边界`),
      source_fact_ids: analysisFacts.map((fact) => fact.id),
    },
    opening_answer: {
      headline: '场景 → 责任 → 方案与取舍 → 验证 → 边界（五段式安全开场）',
      answer: [
        ...resolved.opening.map(({ stage, fact, verificationTopic }) => {
          const label = ANSWER_STAGES.find(([key]) => key === stage)?.[1] || stage;
          return fact
            ? renderStage(label, [fact], '')
            : renderStage(label, [], UNKNOWN_TOPIC_TEXT[verificationTopic]);
        }),
        `【边界】${OWNERSHIP_BOUNDARY}多条 Fact 仅作并列依据，不表示额外因果关系。`,
      ].join('\n'),
      source_fact_ids: openingFacts.map((fact) => fact.id),
      unknowns: resolved.opening
        .filter((item) => !item.fact)
        .map((item) => UNKNOWN_TOPIC_TEXT[item.verificationTopic]),
    },
    questions: plan.questions.map((question, index) => {
      const template = QUESTION_TEMPLATES[question.category];
      const facts = resolved.questions[index];
      const reference = stageReferenceAnswer(context, question.category, facts);
      return {
        id: question.id,
        category: question.category,
        depth: question.depth,
        question: template.question(context.project.name, factQuestionAnchor(facts)),
        intent: template.intent,
        scoring_points: ['先给结论，再引用一条已确认 Fact', '明确说明 Fact 能证明与不能证明的内容', '缺失信息标记待核实，不补造细节'],
        reference_answer: {
          headline: '服务端渲染的五段式参考回答',
          points: reference.points,
          source_fact_ids: reference.sourceFacts.map((fact) => fact.id),
          unknowns: (question.unknown_topics || []).map((topic) => UNKNOWN_TOPIC_TEXT[topic]),
        },
        follow_ups: [template.followUp],
      };
    }),
  };
}

export async function validateProjectInterviewPack(root, input, plan) {
  const errors = [];
  const context = await trustedContext(root, input);
  const targetRole = cleanTargetRole(input?.target_role, context.source.target_job_title);
  if (containsForbiddenSensitiveContent(targetRole)) errors.push({ code: 'forbidden_sensitive_content', path: '/target_role' });
  const validatePackProposalSchema = compileSystemSchema(dynamicPackProposalSchema(context, targetRole), '项目面试训练包计划 Schema');
  if (!validatePackProposalSchema(plan)) errors.push(...schemaErrors(validatePackProposalSchema));
  if (plan?.project_id !== context.project.id) errors.push({ code: 'project_mismatch', expected: context.project.id, actual: plan?.project_id });
  if (plan?.target_role !== targetRole) errors.push({ code: 'target_role_mismatch', expected: targetRole, actual: plan?.target_role });
  const categories = (plan?.questions || []).map((question) => question?.category);
  if (JSON.stringify(categories) !== JSON.stringify(PACK_CATEGORIES)) {
    errors.push({ code: 'question_coverage_invalid', expected: PACK_CATEGORIES, actual: categories });
  }
  const questionIds = (plan?.questions || []).map((question) => question?.id);
  const expectedQuestionIds = PACK_CATEGORIES.map((_, index) => `q${index + 1}`);
  if (JSON.stringify(questionIds) !== JSON.stringify(expectedQuestionIds)) {
    errors.push({ code: 'question_order_invalid', expected: expectedQuestionIds, actual: questionIds });
  }
  const questionDepths = (plan?.questions || []).map((question) => question?.depth);
  if (JSON.stringify(questionDepths) !== JSON.stringify(PACK_DEPTHS)) {
    errors.push({ code: 'question_depth_progression_invalid', expected: PACK_DEPTHS, actual: questionDepths });
  }
  const openingStages = (plan?.opening_sections || []).map((section) => section?.stage);
  if (JSON.stringify(openingStages) !== JSON.stringify(ANSWER_STAGES.map(([stage]) => stage))) {
    errors.push({ code: 'opening_stage_order_invalid', expected: ANSWER_STAGES.map(([stage]) => stage), actual: openingStages });
  }

  const resolved = {
    analysis: (plan?.analysis_facts || []).map((ref, index) => factByRef(context, ref, `/analysis_facts/${index}`, errors)).filter(Boolean),
    opening: (plan?.opening_sections || []).map((section, index) => ({
      stage: section?.stage,
      fact: section?.fact ? factByRef(context, section.fact, `/opening_sections/${index}/fact`, errors) : null,
      verificationTopic: section?.verification_topic,
    })),
    questions: (plan?.questions || []).map((question, questionIndex) => (question?.answer_facts || [])
      .map((ref, factIndex) => factByRef(context, ref, `/questions/${questionIndex}/answer_facts/${factIndex}`, errors))
      .filter(Boolean)),
  };
  const analysisIds = resolved.analysis.map((fact) => fact.id);
  if (new Set(analysisIds).size !== analysisIds.length) errors.push({ code: 'fact_reference_duplicate', path: '/analysis_facts' });
  const openingIds = resolved.opening.filter((item) => item.fact).map((item) => item.fact.id);
  if (!openingIds.length) errors.push({ code: 'opening_fact_required', path: '/opening_sections' });
  if (new Set(openingIds).size !== openingIds.length) errors.push({ code: 'fact_reference_duplicate', path: '/opening_sections' });
  for (const [index, item] of resolved.opening.entries()) {
    if (item.fact && !factSupportsStage(item.fact, item.stage)) {
      errors.push({ code: 'fact_stage_mismatch', path: `/opening_sections/${index}/fact`, stage: item.stage, fact_id: item.fact.id });
    }
  }
  for (const [index, facts] of resolved.questions.entries()) {
    const ids = facts.map((fact) => fact.id);
    if (new Set(ids).size !== ids.length) errors.push({ code: 'fact_reference_duplicate', path: `/questions/${index}/answer_facts` });
    const stage = CATEGORY_STAGE[plan?.questions?.[index]?.category];
    for (const fact of facts) {
      if (!factSupportsStage(fact, stage)) {
        errors.push({ code: 'fact_stage_mismatch', path: `/questions/${index}/answer_facts`, stage, fact_id: fact.id });
      }
    }
  }
  if (errors.length || !resolved.analysis.length) return { valid: false, errors, pack: null };

  const pack = renderPackFromPlan(context, targetRole, plan, resolved);
  const validatePackOutputSchema = systemSchemaValidator(
    ['schemas', 'cn', 'project-interview-pack.schema.json'],
    '项目面试训练包输出 Schema',
  );
  if (!validatePackOutputSchema(pack)) errors.push(...schemaErrors(validatePackOutputSchema));
  if (containsForbiddenSensitiveContent(JSON.stringify(pack))) errors.push({ code: 'forbidden_sensitive_content' });
  return { valid: errors.length === 0, errors, pack };
}

function factRefForPlan(fact) {
  return { fact_id: fact.id, fact_sha256: fact.statement_sha256 };
}

function deterministicStageFacts(context, stage, maximum = 3) {
  return context.project.facts.filter((fact) => factSupportsStage(fact, stage)).slice(0, maximum);
}

export async function buildDeterministicProjectInterviewPack(root, input) {
  const context = await trustedContext(root, input);
  const targetRole = cleanTargetRole(input?.target_role, context.source.target_job_title);
  if (containsForbiddenSensitiveContent(targetRole)) {
    throw domainError('INTERVIEW_INPUT_FORBIDDEN', '目标岗位包含不应发送给模型的具体身份或联系信息');
  }
  const stageFallbackTopic = {
    scenario: 'implementation',
    responsibility: 'responsibility',
    solution: 'tradeoff',
    validation: 'validation',
  };
  const analysisFacts = context.project.facts.slice(0, 4);
  const openingUsed = new Set();
  const openingSections = ANSWER_STAGES.map(([stage]) => {
    const fact = deterministicStageFacts(context, stage).find((candidate) => !openingUsed.has(candidate.id));
    if (!fact) return { stage, fact: null, verification_topic: stageFallbackTopic[stage] };
    openingUsed.add(fact.id);
    return { stage, fact: factRefForPlan(fact), verification_topic: null };
  });
  const plan = {
    schema_version: 1,
    phase: 'pack_plan',
    project_id: context.project.id,
    target_role: targetRole,
    analysis_facts: analysisFacts.map(factRefForPlan),
    opening_sections: openingSections,
    questions: PACK_CATEGORIES.map((category, index) => ({
      id: `q${index + 1}`,
      category,
      depth: PACK_DEPTHS[index],
      answer_facts: deterministicStageFacts(context, CATEGORY_STAGE[category]).map(factRefForPlan),
      unknown_topics: deterministicStageFacts(context, CATEGORY_STAGE[category]).length
        ? []
        : [stageFallbackTopic[CATEGORY_STAGE[category]]],
    })),
  };
  const result = await validateProjectInterviewPack(root, input, plan);
  if (!result.valid || !result.pack) {
    throw domainError('INTERVIEW_PACK_FALLBACK_INVALID', '确定性项目训练包未通过事实与结构校验', result.errors);
  }
  return result.pack;
}

function boundedText(value, label, maximum) {
  const text = String(value || '').trim();
  if (!text) throw domainError('INTERVIEW_INPUT_INVALID', `${label}不能为空`);
  if (text.length > maximum) throw domainError('INTERVIEW_INPUT_TOO_LARGE', `${label}超过 ${maximum} 字符`);
  return text;
}

function answerSegments(answer) {
  return [...new Set(String(answer)
    .split(/[。！？!?；;\n]+/u)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length >= 2))];
}

function normalizedExactClaim(value) {
  return String(value || '').normalize('NFKC').trim().replace(/[。！？!?；;]+$/u, '');
}

function canonicalSupportedClaim(value, projectName) {
  let text = normalizedExactClaim(value).toLowerCase();
  const normalizedProjectName = String(projectName || '').normalize('NFKC').trim().toLowerCase();
  if (normalizedProjectName.length >= 2) text = text.split(normalizedProjectName).join('');
  return text
    .replace(/^\s*(?:我|本人)?\s*(?:在|于)?\s*(?:这个|本)?\s*(?:项目)?\s*(?:中|里)\s*/u, '')
    .replace(/(?:独立完成|独立开发|独立构建|独立搭建)/gu, '独立实现')
    .replace(/(?:完成|开发|构建|搭建)(?:了)?/gu, '实现')
    .replace(/实现了/gu, '实现')
    .replace(/功能/gu, '模块')
    .replace(/(?:使用|采用|基于|接入)/gu, '使用')
    .replace(/\b(?:implemented|developed|built|completed)\b/giu, 'implement')
    .replace(/\bfeature\b/giu, 'module')
    .replace(/\b(?:i|in|the|a|an)\b/giu, '')
    .replace(/[的]+/gu, '')
    .replace(/[^\p{Letter}\p{Number}%％]+/gu, '');
}

function claimSupportedByFacts(context, claim) {
  const normalized = normalizedExactClaim(claim);
  if (context.project.facts.some((fact) => normalizedExactClaim(fact.statement) === normalized)) return true;
  if ((claim.match(METRIC_CLAIM) || []).length > 0) return false;
  const canonical = canonicalSupportedClaim(claim, context.project.name);
  if (canonical.length < 6) return false;
  const claimIsNegated = NEGATED_ACTION.test(claim);
  return context.project.facts.some((fact) => (
    NEGATED_ACTION.test(fact.statement) === claimIsNegated
      && canonicalSupportedClaim(fact.statement, context.project.name) === canonical
  ));
}

export async function buildProjectInterviewReviewRequest(root, input) {
  const context = await trustedContext(root, input);
  const targetRole = cleanTargetRole(input?.target_role, context.source.target_job_title);
  const question = boundedText(input?.question, '面试问题', 1200);
  const answer = boundedText(input?.answer, '候选人回答', 6000);
  if (containsForbiddenSensitiveContent(targetRole) || containsForbiddenSensitiveContent(question)) {
    throw domainError('INTERVIEW_INPUT_FORBIDDEN', '目标岗位或面试问题包含不应发送给模型的具体身份或联系信息');
  }
  if (containsForbiddenSensitiveContent(answer)) throw domainError('INTERVIEW_INPUT_FORBIDDEN', '候选人回答包含不应发送给模型的具体身份或联系信息');
  if (answerSegments(answer).length > 64) {
    throw domainError('INTERVIEW_INPUT_TOO_LARGE', '候选人回答包含过多独立片段，请精简后再提交');
  }
  const instructions = interviewInstructions();
  const questionHash = sha256(Buffer.from(question, 'utf8'));
  const answerHash = sha256(Buffer.from(answer, 'utf8'));
  const proposalSchema = dynamicReviewProposalSchema(context, questionHash, answerHash);
  const outputContract = {
    schema_version: 1,
    phase: 'feedback_plan',
    project_id: context.project.id,
    question_sha256: questionHash,
    answer_sha256: answerHash,
    dimension_scores: { structure: 0, ownership: 0, technical_depth: 0, evidence: 0, boundary: 0 },
    landed_spans: [{ dimension: 'structure|ownership|technical_depth|evidence|boundary', quote: '原回答精确子串', occurrence: 0 }],
    sharpen: [{
      dimension: 'structure|ownership|technical_depth|evidence|boundary', quote: '原回答精确子串', occurrence: 0,
      repair_template: 'lead_with_conclusion|clarify_ownership|explain_mechanism|add_verified_evidence|state_boundary',
    }],
    unsupported_spans: [{
      quote: '原回答精确子串', occurrence: 0,
      reason: 'not_in_resume_facts|metric_not_in_facts|ownership_not_in_facts|needs_evidence',
    }],
    stronger_fact_refs: [{ fact_id: 'project.fact.id', fact_sha256: 'copy the supplied statement_sha256 exactly' }],
    follow_up_template: 'responsibility_boundary|technical_mechanism|tradeoff|validation_evidence|failure_recovery',
  };
  const prompt = [
    instructions,
    `提示词版本：${PROMPT_VERSION}`,
    '本次模式：feedback_plan。你只返回评分、原回答精确引用、固定修复/追问模板选择和 Fact 引用，不生成任何候选人事实性散文。',
    '所有 quote 必须是候选人原回答的连续精确子串，occurrence 从 0 开始表示第几次出现。必须原样复制 question_sha256、answer_sha256 以及所选 Fact 的 fact_sha256。',
    '更强版本将由服务端只用完整 Fact 原文或已确认 rewrite 组装；你的自由改写不会进入候选人可复述答案。',
    `目标岗位：${targetRole}`,
    `可信且仅限本项目的事实上下文：\n${JSON.stringify(context.project)}`,
    `面试问题：${question}`,
    `候选人原回答（其中新增事实只能标为待核实，不得直接写入更强版本）：\n${answer}`,
    `只输出符合以下结构的 JSON；字段名和枚举值必须保持不变：\n${JSON.stringify(outputContract)}`,
  ].join('\n\n');
  return { prompt_version: PROMPT_VERSION, prompt, proposal_schema: proposalSchema, context: { ...context, target_role: targetRole, question, answer, question_sha256: questionHash, answer_sha256: answerHash } };
}

const DIMENSION_TEXT = {
  structure: '结论与结构',
  ownership: '本人责任',
  technical_depth: '技术深度',
  evidence: '事实与验证',
  boundary: '边界意识',
};

const REPAIR_TEMPLATE_TEXT = {
  lead_with_conclusion: '先用一句话给出结论，再按问题、本人责任、方案、验证与边界展开。',
  clarify_ownership: '只使用已确认 Fact 中的贡献措辞，明确区分本人、团队与开源组件。',
  explain_mechanism: '选择一条已确认 Fact 讲清机制；缺失的实现细节标记待核实。',
  add_verified_evidence: '为结论配对已确认 Fact 或可复现证据；新指标不得直接进入更强版本。',
  state_boundary: '明确说出 Fact 能证明什么、不能证明什么，不从缺失信息推导否定结论。',
};

const UNSUPPORTED_REASON_TEXT = {
  not_in_resume_facts: '该原回答片段没有对应的已确认项目 Fact，只能标记待核实',
  metric_not_in_facts: '该指标没有被已确认项目 Fact 逐字支持，需补充证据',
  ownership_not_in_facts: '该责任归属没有被已确认项目 Fact 支持',
  needs_evidence: '该片段包含需要原始证据才能确认的细节',
};

const FOLLOW_UP_TEXT = {
  responsibility_boundary: '请只选一条已确认 Fact，说明你亲自承担的工作，并明确团队或开源组件的边界。',
  technical_mechanism: '请选一条已确认 Fact 继续讲技术机制；Fact 未覆盖的细节直接回答待核实。',
  tradeoff: '请区分已有 Fact 能证明的选择，以及面试前还要补证的取舍理由。',
  validation_evidence: '你会用哪一条已确认 Fact 或哪份待补证据验证这个结论？',
  failure_recovery: '现有 Fact 能证明哪一部分失败处理？哪一部分仍需本人核实？',
};

function exactQuoteExists(answer, quote, occurrence) {
  if (typeof quote !== 'string' || !quote || !Number.isInteger(occurrence) || occurrence < 0) return false;
  let offset = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const found = answer.indexOf(quote, offset);
    if (found < 0) return false;
    if (index === occurrence) return true;
    offset = found + Math.max(1, quote.length);
  }
  return false;
}

function validateAnswerSpans(answer, spans, path, errors) {
  for (const [index, span] of (spans || []).entries()) {
    if (!exactQuoteExists(answer, span?.quote, span?.occurrence)) {
      errors.push({ code: 'answer_quote_mismatch', path: `${path}/${index}`, quote: span?.quote, occurrence: span?.occurrence });
    }
  }
}

function unsupportedAnswerSegments(context, answer) {
  return answerSegments(answer)
    .filter((segment) => !claimSupportedByFacts(context, segment))
    .filter((segment) => (segment.match(METRIC_CLAIM) || []).length > 0
      || OWNERSHIP_CLAIM.test(segment)
      || FACTUAL_ACTION_CLAIM.test(segment))
    .map((claim) => ({
      claim,
      reason: (claim.match(METRIC_CLAIM) || []).length > 0
        ? UNSUPPORTED_REASON_TEXT.metric_not_in_facts
        : OWNERSHIP_CLAIM.test(claim)
          ? UNSUPPORTED_REASON_TEXT.ownership_not_in_facts
          : UNSUPPORTED_REASON_TEXT.not_in_resume_facts,
    }));
}

function mergeUnsupportedClaims(context, answer, modelSpans) {
  const derived = unsupportedAnswerSegments(context, answer);
  const model = modelSpans
    .filter((span) => !claimSupportedByFacts(context, span.quote))
    .map((span) => ({ claim: span.quote, reason: UNSUPPORTED_REASON_TEXT[span.reason] }));
  const merged = [];
  for (const item of [...derived, ...model]) {
    if (!item.claim || merged.some((existing) => existing.claim === item.claim
      || existing.claim.includes(item.claim)
      || item.claim.includes(existing.claim))) continue;
    merged.push(item);
  }
  return merged;
}

function renderReviewFromPlan(context, question, answer, plan, strongerFacts) {
  const scoreKeys = ['structure', 'ownership', 'technical_depth', 'evidence', 'boundary'];
  const unsupported = mergeUnsupportedClaims(context, answer, plan.unsupported_spans);
  const dimensionScores = { ...plan.dimension_scores };
  if (unsupported.length) {
    dimensionScores.technical_depth = Math.min(dimensionScores.technical_depth, 8);
    dimensionScores.evidence = Math.min(dimensionScores.evidence, 4);
    dimensionScores.boundary = Math.min(dimensionScores.boundary, 4);
    if (unsupported.some((item) => item.reason === UNSUPPORTED_REASON_TEXT.ownership_not_in_facts)) {
      dimensionScores.ownership = Math.min(dimensionScores.ownership, 4);
    }
  }
  const score = scoreKeys.reduce((sum, key) => sum + dimensionScores[key], 0);
  const landedSpans = plan.landed_spans.filter((span) => !unsupported.some((item) => (
    item.claim === span.quote || item.claim.includes(span.quote) || span.quote.includes(item.claim)
  )));
  const strongerAnswer = directFiveStageAnswer(strongerFacts);
  return {
    schema_version: 1,
    phase: 'feedback',
    project_id: context.project.id,
    question,
    status: score >= 80 ? 'strong' : score >= 60 ? 'solid' : 'gap',
    score,
    dimension_scores: dimensionScores,
    landed: landedSpans.length
      ? landedSpans.map((span) => `AI 选择“${span.quote}”作为【${DIMENSION_TEXT[span.dimension]}】维度的表达观察；这不代表其中任何经历事实已被确认。`)
      : ['回答已收到；当前没有可与“待核实主张”分离的正向表达观察。'],
    sharpen: plan.sharpen.map((item) => ({
      issue: `需加强【${DIMENSION_TEXT[item.dimension]}】：“${item.quote}”`,
      repair: REPAIR_TEMPLATE_TEXT[item.repair_template],
    })),
    unsupported_claims: unsupported,
    stronger_version: {
      headline: '只用已确认 Fact 生成的五段式安全回答',
      answer: strongerAnswer.answer,
      source_fact_ids: strongerAnswer.sourceFacts.map((fact) => fact.id),
      unknowns: ['原回答中未被上述 Fact 覆盖的新细节均需本人补充证据'],
    },
    follow_up_question: FOLLOW_UP_TEXT[plan.follow_up_template],
  };
}

export async function validateProjectInterviewReview(root, input, plan) {
  const errors = [];
  const context = await trustedContext(root, input);
  const question = boundedText(input?.question, '面试问题', 1200);
  const answer = boundedText(input?.answer, '候选人回答', 6000);
  const targetRole = cleanTargetRole(input?.target_role, context.source.target_job_title);
  if (containsForbiddenSensitiveContent(targetRole)) errors.push({ code: 'forbidden_sensitive_content', path: '/target_role' });
  if (containsForbiddenSensitiveContent(question)) errors.push({ code: 'forbidden_sensitive_content', path: '/question' });
  if (containsForbiddenSensitiveContent(answer)) errors.push({ code: 'forbidden_sensitive_content', path: '/answer' });
  const validateReviewProposalSchema = compileSystemSchema(
    dynamicReviewProposalSchema(context, sha256(Buffer.from(question, 'utf8')), sha256(Buffer.from(answer, 'utf8'))),
    '项目面试点评计划 Schema',
  );
  if (!validateReviewProposalSchema(plan)) errors.push(...schemaErrors(validateReviewProposalSchema));
  if (plan?.project_id !== context.project.id) errors.push({ code: 'project_mismatch', expected: context.project.id, actual: plan?.project_id });
  const questionHash = sha256(Buffer.from(question, 'utf8'));
  const answerHash = sha256(Buffer.from(answer, 'utf8'));
  if (plan?.question_sha256 !== questionHash) errors.push({ code: 'question_hash_mismatch', expected: questionHash, actual: plan?.question_sha256 });
  if (plan?.answer_sha256 !== answerHash) errors.push({ code: 'answer_hash_mismatch', expected: answerHash, actual: plan?.answer_sha256 });
  validateAnswerSpans(answer, plan?.landed_spans, '/landed_spans', errors);
  validateAnswerSpans(answer, plan?.sharpen, '/sharpen', errors);
  validateAnswerSpans(answer, plan?.unsupported_spans, '/unsupported_spans', errors);
  const strongerFacts = (plan?.stronger_fact_refs || [])
    .map((ref, index) => factByRef(context, ref, `/stronger_fact_refs/${index}`, errors))
    .filter(Boolean);
  const strongerIds = strongerFacts.map((fact) => fact.id);
  if (new Set(strongerIds).size !== strongerIds.length) errors.push({ code: 'fact_reference_duplicate', path: '/stronger_fact_refs' });
  if (errors.length || !strongerFacts.length) return { valid: false, errors, review: null };

  const review = renderReviewFromPlan(context, question, answer, plan, strongerFacts);
  const validateReviewOutputSchema = systemSchemaValidator(
    ['schemas', 'cn', 'project-interview-review.schema.json'],
    '项目面试点评输出 Schema',
  );
  if (!validateReviewOutputSchema(review)) errors.push(...schemaErrors(validateReviewOutputSchema));
  if (containsForbiddenSensitiveContent(JSON.stringify(review))) errors.push({ code: 'forbidden_sensitive_content' });
  return { valid: errors.length === 0, errors, review };
}

export async function buildDeterministicProjectInterviewReview(root, input) {
  const context = await trustedContext(root, input);
  const question = boundedText(input?.question, '面试问题', 1200);
  const answer = boundedText(input?.answer, '候选人回答', 6000);
  const targetRole = cleanTargetRole(input?.target_role, context.source.target_job_title);
  if (containsForbiddenSensitiveContent(targetRole) || containsForbiddenSensitiveContent(question)) {
    throw domainError('INTERVIEW_INPUT_FORBIDDEN', '目标岗位或面试问题包含不应发送给模型的具体身份或联系信息');
  }
  if (containsForbiddenSensitiveContent(answer)) {
    throw domainError('INTERVIEW_INPUT_FORBIDDEN', '候选人回答包含不应发送给模型的具体身份或联系信息');
  }
  if (answerSegments(answer).length > 64) {
    throw domainError('INTERVIEW_INPUT_TOO_LARGE', '候选人回答包含过多独立片段，请精简后再提交');
  }
  const exactQuote = Array.from(answer).slice(0, 400).join('');
  const strongerFacts = [];
  for (const stage of ANSWER_STAGES.map(([key]) => key)) {
    const candidate = deterministicStageFacts(context, stage, 1)[0];
    if (candidate && !strongerFacts.some((fact) => fact.id === candidate.id)) strongerFacts.push(candidate);
  }
  for (const fact of context.project.facts) {
    if (strongerFacts.length >= 6) break;
    if (!strongerFacts.some((candidate) => candidate.id === fact.id)) strongerFacts.push(fact);
  }
  const plan = {
    schema_version: 1,
    phase: 'feedback_plan',
    project_id: context.project.id,
    question_sha256: sha256(Buffer.from(question, 'utf8')),
    answer_sha256: sha256(Buffer.from(answer, 'utf8')),
    dimension_scores: { structure: 0, ownership: 0, technical_depth: 0, evidence: 0, boundary: 0 },
    landed_spans: [{ dimension: 'structure', quote: exactQuote, occurrence: 0 }],
    sharpen: [{ dimension: 'evidence', quote: exactQuote, occurrence: 0, repair_template: 'add_verified_evidence' }],
    unsupported_spans: [],
    stronger_fact_refs: strongerFacts.map(factRefForPlan),
    follow_up_template: 'validation_evidence',
  };
  const result = await validateProjectInterviewReview(root, input, plan);
  if (!result.valid || !result.review) {
    throw domainError('INTERVIEW_REVIEW_FALLBACK_INVALID', '确定性项目面试反馈未通过事实与结构校验', result.errors);
  }
  return result.review;
}
