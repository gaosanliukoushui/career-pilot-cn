import Ajv2020 from 'ajv/dist/2020.js';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCandidateProfile } from './profile-core.mjs';
import { sha256, stableJson } from './hash-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ajv = new Ajv2020({ allErrors: true, strict: true });
const jobSchema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'cn', 'job-posting.schema.json'), 'utf8'));
const matchSchema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'cn', 'match-report.schema.json'), 'utf8'));
const fitProposalSchema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'cn', 'fit-proposal.schema.json'), 'utf8'));
const validateJobSchema = ajv.compile(jobSchema);
const validateMatchSchema = ajv.compile(matchSchema);
const validateFitProposalSchema = ajv.compile(fitProposalSchema);

export const FIT_WEIGHTS = Object.freeze({
  role_major: 0.30,
  evidence: 0.30,
  career_direction: 0.15,
  mobility: 0.10,
  development: 0.10,
  source_reliability: 0.05,
});

const DEGREE_RANK = Object.freeze({ secondary: 1, associate: 2, bachelor: 3, master: 4, doctorate: 5 });
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENT_TEXT = 2_000_000;
const RESTRICTED_VALUE_PATTERN = /\b\d{17}[\dXx]\b/g;

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, 'utf8');
  renameSync(temporary, path);
}

function schemaErrors(validator) {
  return (validator.errors || []).map((error) => ({
    code: 'schema_invalid',
    path: error.instancePath || '/',
    message: error.message || 'invalid value',
  }));
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function safeNarrative(value) {
  return cleanText(value).replace(RESTRICTED_VALUE_PATTERN, '[需本人手工填写]');
}

function normalized(value) {
  return String(value ?? '').toLowerCase().replace(/[\s,，、;；:：()（）\[\]【】/\\_-]+/g, '');
}

function lineContaining(text, pattern) {
  return text.split('\n').map((line) => line.trim()).find((line) => pattern.test(line)) || '';
}

function employerType(name, text) {
  const haystack = `${name}\n${text}`;
  if (/中央企业|央企|国资委直属/i.test(haystack)) return 'central_soe';
  if (/地方国企|市属国企|省属国企|国有企业/i.test(haystack)) return 'local_soe';
  if (/银行|农商行|信用社/i.test(haystack)) return 'bank';
  if (/中国移动|中国联通|中国电信|运营商/i.test(haystack)) return 'telecom';
  if (/事业单位/i.test(haystack)) return 'public_institution';
  return 'unknown';
}

function jobIdentity(posting) {
  const sourceRef = cleanText(posting.source?.ref || '');
  const employerName = cleanText(posting.employer?.name || '');
  if (employerName && employerName !== '待确认单位' && posting.job_code) return `${normalized(employerName)}|${normalized(posting.job_code)}`;
  if (['public_url', 'official_url'].includes(posting.source?.kind) && (posting.source?.final_url || sourceRef)) {
    return cleanText(posting.source.final_url || sourceRef).toLowerCase();
  }
  return sha256(cleanText(posting.raw_text));
}

function jobStructureHash(posting) {
  const snapshot = structuredClone(posting);
  snapshot.confirmation = { status: 'pending', confirmed_at: null, structure_sha256: null };
  return sha256(stableJson(snapshot));
}

export function finalizeJobPosting(input) {
  const posting = structuredClone(input);
  posting.raw_text = cleanText(posting.raw_text);
  posting.content_sha256 = sha256(posting.raw_text);
  posting.id = `job.${sha256(jobIdentity(posting)).slice(0, 24)}`;
  const validation = validateJobPosting(posting);
  if (!validation.valid) {
    const error = new Error('JobPosting validation failed');
    error.code = 'JOB_POSTING_INVALID';
    error.details = validation.errors;
    throw error;
  }
  return posting;
}

function inferRules(text) {
  const rules = [];
  const add = (field, operator, expected, sourceQuote, severity = 'hard', confidence = 0.95) => {
    const id = `rule.${field}.${rules.filter((item) => item.field === field).length + 1}`;
    const preferenceOnly = /优先|建议|鼓励|可优先|视为加分|加分项/i.test(sourceQuote);
    rules.push({
      id, field, operator, expected,
      severity: preferenceOnly && severity === 'hard' ? 'soft' : severity,
      explicit: true,
      source_quote: sourceQuote,
      confidence,
      confirmation_status: 'pending',
    });
  };

  const degreeQuote = lineContaining(text, /博士|硕士|本科|大专|专科.*(?:及以上|以上|学历)/i);
  if (degreeQuote) {
    const degree = /博士/.test(degreeQuote) ? 'doctorate'
      : /硕士/.test(degreeQuote) ? 'master'
        : /本科/.test(degreeQuote) ? 'bachelor'
          : /大专|专科/.test(degreeQuote) ? 'associate' : null;
    if (degree) add('degree', 'at_least', degree, degreeQuote);
  }

  const majorQuote = lineContaining(text, /(?:专业要求|所学专业|专业范围|专业)：?/i);
  if (majorQuote) {
    const tail = majorQuote.replace(/^.*?(?:专业要求|所学专业|专业范围|专业)\s*[：:]?\s*/i, '');
    const majors = tail.split(/[、，,；;或及]/).map((item) => item.trim()).filter((item) => item.length >= 2).slice(0, 20);
    if (majors.length) add('major_name', 'contains_any', majors, majorQuote);
  }

  const majorCodeQuote = lineContaining(text, /专业代码(?:要求|范围)?\s*[：:]/i);
  if (majorCodeQuote) {
    const codes = [...majorCodeQuote.matchAll(/\b\d{4,8}[A-Za-z]?\b/g)].map((match) => match[0]);
    if (codes.length) add('major_code', 'one_of', [...new Set(codes)].slice(0, 30), majorCodeQuote);
  }

  const cohortQuote = lineContaining(text, /20\d{2}\s*届|应届毕业生|应届生/i);
  const cohortMatch = cohortQuote.match(/(20\d{2})\s*届/);
  if (cohortMatch) add('cohort', 'equals', Number(cohortMatch[1]), cohortQuote);
  else if (cohortQuote) add('fresh_graduate_status', 'one_of', ['domestic', 'overseas'], cohortQuote);

  const graduationQuote = lineContaining(text, /(?:毕业时间|毕业日期|取得学历时间).*(?:至|到|—|~|～)/i);
  if (graduationQuote) {
    const dates = [...graduationQuote.matchAll(/(20\d{2})[年\-\/.](\d{1,2})[月\-\/.](\d{1,2})日?/g)]
      .map((match) => `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`);
    if (dates.length >= 2) add('graduation_date', 'between', [dates[0], dates[1]], graduationQuote);
  }

  const cetQuote = lineContaining(text, /(?:大学英语|英语).{0,8}(?:四级|六级|CET[- ]?[46])/i);
  if (cetQuote) {
    const kind = /六级|CET[- ]?6/i.test(cetQuote) ? 'CET6' : 'CET4';
    const score = cetQuote.match(/(?:不低于|达到|成绩)\s*(\d{3})/i)?.[1];
    add('language_certificate', 'at_least', { kind, ...(score ? { minimum_score: Number(score) } : {}) }, cetQuote);
  }

  const credentialQuote = lineContaining(text, /(?:资格证书|证书要求|须持有|应持有|取得).{0,80}(?:证书|资格)/i);
  if (credentialQuote) {
    const tail = credentialQuote.replace(/^.*?(?:资格证书|证书要求)\s*[：:]?\s*/i, '');
    const credentials = tail.split(/[、，,；;]/)
      .map((item) => item.replace(/^(?:须|应|必须)?(?:持有|取得)?/i, '').replace(/(?:者)?优先.*$/i, '').trim())
      .filter((item) => /证书|资格/.test(item) && item.length >= 3)
      .slice(0, 20);
    if (credentials.length) add('credential', 'contains_any', credentials, credentialQuote, /优先/.test(credentialQuote) ? 'soft' : 'hard');
  }

  const politicalQuote = lineContaining(text, /中共党员|政治面貌/i);
  if (politicalQuote && /要求|须|必须|应为|中共党员优先/i.test(politicalQuote)) {
    add('political_status', /优先/.test(politicalQuote) ? 'contains_any' : 'equals', ['中共党员', '中共预备党员'], politicalQuote, /优先/.test(politicalQuote) ? 'soft' : 'hard');
  }
  return rules;
}

export function inferJobPosting(rawText, source = { kind: 'pasted_text' }, hints = {}) {
  const text = cleanText(rawText);
  if (!text) throw new Error('Job source text is required');
  if (text.length > MAX_DOCUMENT_TEXT) throw new Error('Job source text exceeds the supported size');
  const employerLine = lineContaining(text, /(?:招聘单位|用人单位|公司名称|单位名称)\s*[：:]/i);
  const employerName = cleanText(hints.employer?.name || employerLine.replace(/^.*?[：:]/, '') || '待确认单位');
  const titleLine = lineContaining(text, /(?:岗位名称|招聘岗位|职位名称)\s*[：:]/i);
  const firstLine = text.split('\n').map((line) => line.trim()).find(Boolean) || '待确认岗位';
  const title = cleanText(hints.title || titleLine.replace(/^.*?[：:]/, '') || firstLine).slice(0, 200);
  const codeLine = lineContaining(text, /(?:岗位代码|职位编号|招聘编号|职位代码)\s*[：:]/i);
  const jobCode = cleanText(hints.job_code || codeLine.replace(/^.*?[：:]/, ''));
  const cohort = Number(hints.recruitment?.cohort || text.match(/(20\d{2})\s*届/)?.[1]) || undefined;
  const deadlineMatch = hints.recruitment?.deadline || text.match(/(?:截止(?:日期|时间)?|报名截止)\s*[：:]?\s*(20\d{2})[年\-/\.](\d{1,2})[月\-/\.](\d{1,2})日?/)?.slice(1, 4);
  const deadline = Array.isArray(deadlineMatch)
    ? `${deadlineMatch[0]}-${String(deadlineMatch[1]).padStart(2, '0')}-${String(deadlineMatch[2]).padStart(2, '0')}`
    : deadlineMatch;
  const locationLine = lineContaining(text, /(?:工作地点|工作城市|招聘地点)\s*[：:]/i);
  const locations = hints.locations || cleanText(locationLine.replace(/^.*?[：:]/, ''))
    .split(/[、，,；;]/).map((item) => item.trim()).filter(Boolean);
  const recruitment = {
    track: hints.recruitment?.track || (/校招|校园招聘|应届/.test(text) ? 'campus' : 'unknown'),
    ...(cohort ? { cohort } : {}),
    ...(deadline ? { deadline } : {}),
  };
  const contentHash = sha256(text);
  const sourceRef = cleanText(source.ref || '');
  const posting = {
    schema_version: 1,
    id: `job.${contentHash.slice(0, 24)}`,
    source: {
      kind: source.kind || 'pasted_text',
      ...(sourceRef ? { ref: sourceRef } : {}),
      ...(source.file_sha256 ? { file_sha256: source.file_sha256 } : {}),
      ...(source.final_url ? { final_url: cleanText(source.final_url) } : {}),
      ...(Array.isArray(source.redirect_chain) ? { redirect_chain: source.redirect_chain.map(cleanText) } : {}),
      ...(source.fetched_at ? { fetched_at: source.fetched_at } : {}),
      ...(source.page_title ? { page_title: cleanText(source.page_title) } : {}),
      ...(source.capture_method ? { capture_method: source.capture_method } : {}),
      ...(['public_url', 'official_url'].includes(source.kind) ? {
        official: Boolean(source.official),
        official_basis: source.official_basis || 'unconfirmed',
        official_evidence: cleanText(source.official_evidence || '等待用户核对招聘单位域名或正式招聘平台'),
      } : {}),
    },
    captured_at: hints.captured_at || new Date().toISOString(),
    content_sha256: contentHash,
    employer: { name: employerName, type: hints.employer?.type || employerType(employerName, text) },
    title,
    ...(jobCode ? { job_code: jobCode } : {}),
    recruitment,
    locations,
    raw_text: text,
    rules: hints.rules || inferRules(text),
    posting_status: hints.posting_status || (deadline && deadline < new Date().toISOString().slice(0, 10) ? 'expired' : 'unknown'),
    confirmation: { status: 'pending', confirmed_at: null, structure_sha256: null },
  };
  return finalizeJobPosting(posting);
}

function assertRegularSourceFile(path) {
  if (!existsSync(path)) throw new Error(`Job source file not found: ${path}`);
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('Job source must be a regular file, not a link');
  if (statSync(path).size > MAX_SOURCE_BYTES) throw new Error('Job source file exceeds 10 MB');
}

async function docxText(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('DOCX signature is invalid');
  const JSZip = (await import('jszip')).default;
  const archive = await JSZip.loadAsync(bytes);
  const document = archive.file('word/document.xml');
  if (!document) throw new Error('DOCX does not contain word/document.xml');
  const xml = await document.async('string');
  if (xml.length > MAX_DOCUMENT_TEXT * 5) throw new Error('DOCX expanded content is too large');
  return cleanText(xml
    .replace(/<w:tab\/?\s*>/g, '\t')
    .replace(/<w:br\/?\s*>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
}

async function pdfText(bytes) {
  if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('PDF signature is invalid');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true }).promise;
  if (document.numPages > 200) throw new Error('PDF has too many pages');
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => item.str).join(' '));
  }
  return cleanText(pages.join('\n'));
}

export async function parseJobFile(path, hints = {}) {
  const absolute = resolve(path);
  assertRegularSourceFile(absolute);
  if (hints.allowed_root) {
    const allowedRoot = resolve(hints.allowed_root);
    if (!existsSync(allowedRoot) || lstatSync(allowedRoot).isSymbolicLink() || !lstatSync(allowedRoot).isDirectory()) {
      throw new Error('Job upload root must be a real directory');
    }
    const realRoot = realpathSync(allowedRoot);
    const realFile = realpathSync(absolute);
    const relativeFile = relative(realRoot, realFile);
    if (relativeFile.startsWith('..') || isAbsolute(relativeFile) || relativeFile === '') {
      throw new Error('Job upload escaped the allowed directory');
    }
  }
  const extension = extname(absolute).toLowerCase();
  if (!['.pdf', '.docx'].includes(extension)) throw new Error('Only PDF and DOCX job sources are supported');
  const bytes = readFileSync(absolute);
  const rawText = extension === '.pdf' ? await pdfText(bytes) : await docxText(bytes);
  if (!rawText) throw new Error('No readable text was found in the job source; image OCR is not supported');
  return inferJobPosting(rawText, {
    kind: extension.slice(1),
    ref: hints.source_ref || basename(absolute),
    file_sha256: sha256(bytes),
  }, hints);
}

function privateAddress(address) {
  if (!isIP(address)) return true;
  const lower = address.toLowerCase();
  if (lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:')
    || lower.startsWith('::ffff:10.') || lower.startsWith('::ffff:127.') || lower.startsWith('::ffff:192.168.')
    || /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(lower)) return true;
  const parts = address.split('.').map(Number);
  if (parts.length !== 4) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168);
}

async function assertPublicUrl(value, { resolveDns = true } = {}) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP(S) job URLs are supported');
  if (/^(localhost|.*\.local)$/i.test(url.hostname)) throw new Error('Local job URLs are not allowed');
  if (resolveDns) {
    const addresses = await lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some((item) => privateAddress(item.address))) throw new Error('Private or unresolved job URLs are not allowed');
  }
  return url;
}

async function parseBrowserRenderedJobUrl(value, hints = {}) {
  const originalUrl = (await assertPublicUrl(value)).href;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const checkedHosts = new Map();
  try {
    const context = await browser.newContext({ javaScriptEnabled: true, serviceWorkers: 'block' });
    await context.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      if (/^(?:data|blob|about):/i.test(requestUrl)) return route.continue();
      try {
        const parsed = new URL(requestUrl);
        const cached = checkedHosts.get(parsed.hostname);
        if (cached === false) return route.abort('blockedbyclient');
        if (cached !== true) {
          await assertPublicUrl(requestUrl);
          checkedHosts.set(parsed.hostname, true);
        }
        return route.continue();
      } catch {
        try { checkedHosts.set(new URL(requestUrl).hostname, false); } catch { /* malformed URL */ }
        return route.abort('blockedbyclient');
      }
    });
    const page = await context.newPage();
    const response = await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    if (!response) throw new Error('Browser navigation returned no response');
    if (response.status() >= 400) throw new Error(`Job URL returned HTTP ${response.status()}`);
    try { await page.waitForLoadState('networkidle', { timeout: 3_000 }); } catch { /* dynamic pages may keep polling */ }
    const finalUrl = (await assertPublicUrl(page.url())).href;
    const redirects = [];
    let request = response.request();
    while (request) {
      redirects.unshift(request.url());
      request = request.redirectedFrom();
    }
    if (!redirects.length || redirects[0] !== originalUrl) redirects.unshift(originalUrl);
    if (redirects.at(-1) !== finalUrl) redirects.push(finalUrl);
    const pageTitle = cleanText(await page.title());
    const text = cleanText(await page.locator('body').innerText({ timeout: 5_000 }));
    if (!text || text.length < 40) throw new Error('Browser-rendered job page did not contain enough readable text');
    return inferJobPosting(text, {
      kind: 'public_url', ref: originalUrl, final_url: finalUrl,
      redirect_chain: [...new Set(redirects)], fetched_at: new Date().toISOString(), page_title: pageTitle,
      capture_method: 'browser', official: false, official_basis: 'unconfirmed',
      official_evidence: '等待用户核对招聘单位域名或正式招聘平台',
    }, hints);
  } finally {
    await browser.close();
  }
}

export async function parseJobUrl(value, hints = {}, fetchImpl = fetch) {
  if (fetchImpl === fetch && hints.browser_first !== false) {
    try {
      return await parseBrowserRenderedJobUrl(value, hints);
    } catch (error) {
      if (hints.browser_required) throw error;
    }
  }
  const resolveDns = fetchImpl === fetch;
  const originalUrl = (await assertPublicUrl(value, { resolveDns })).href;
  let url = new URL(originalUrl);
  const redirectChain = [originalUrl];
  for (let redirect = 0; redirect <= 4; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response;
    try {
      response = await fetchImpl(url, { redirect: 'manual', signal: controller.signal, headers: { 'user-agent': 'CareerPilot-CN/1.0' } });
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirect === 4) throw new Error('Too many job URL redirects');
      const location = response.headers.get('location');
      if (!location) throw new Error('Job URL redirect did not include a location');
      url = await assertPublicUrl(new URL(location, url).href, { resolveDns });
      redirectChain.push(url.href);
      continue;
    }
    if (!response.ok) throw new Error(`Job URL returned HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_SOURCE_BYTES) throw new Error('Job URL response exceeds 10 MB');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_SOURCE_BYTES) throw new Error('Job URL response exceeds 10 MB');
    const contentType = response.headers.get('content-type') || '';
    let text;
    let pageTitle = '';
    if (/pdf/i.test(contentType)) text = await pdfText(bytes);
    else if (/officedocument|wordprocessingml/i.test(contentType)) text = await docxText(bytes);
    else {
      const html = bytes.toString('utf8');
      pageTitle = cleanText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      text = cleanText(html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, '\n'));
    }
    return inferJobPosting(text, {
      kind: 'public_url',
      ref: originalUrl,
      final_url: url.href,
      redirect_chain: redirectChain,
      fetched_at: new Date().toISOString(),
      page_title: pageTitle,
      capture_method: 'http',
      official: false,
      official_basis: 'unconfirmed',
      official_evidence: '等待用户核对招聘单位域名或正式招聘平台',
    }, hints);
  }
  throw new Error('Unable to load job URL');
}

export function validateJobPosting(posting) {
  const errors = [];
  if (!validateJobSchema(posting)) errors.push(...schemaErrors(validateJobSchema));
  const seenRuleIds = new Set();
  for (const rule of posting?.rules || []) {
    if (seenRuleIds.has(rule.id)) errors.push({ code: 'duplicate_rule_id', id: rule.id });
    seenRuleIds.add(rule.id);
    if (rule.confirmation_status !== 'rejected' && rule.explicit && (!rule.source_quote || !posting.raw_text.includes(rule.source_quote))) {
      errors.push({ code: 'explicit_rule_quote_missing', id: rule.id });
    }
    if (rule.confirmation_status === 'confirmed' && rule.severity === 'hard' && !rule.source_quote) {
      errors.push({ code: 'confirmed_hard_rule_quote_missing', id: rule.id });
    }
    if (rule.severity === 'hard' && /优先|建议|鼓励|可优先|视为加分|加分项/i.test(rule.source_quote || '')) {
      errors.push({ code: 'preference_language_cannot_be_hard_rule', id: rule.id });
    }
  }
  if (posting?.content_sha256 && posting.content_sha256 !== sha256(cleanText(posting.raw_text))) {
    errors.push({ code: 'content_hash_mismatch' });
  }
  if (posting?.id && posting.id !== `job.${sha256(jobIdentity(posting)).slice(0, 24)}`) errors.push({ code: 'job_id_mismatch' });
  if (posting?.source?.kind === 'official_url'
    && (!posting.source.official || posting.source.official_basis === 'unconfirmed' || !posting.source.official_evidence)) {
    errors.push({ code: 'official_source_unverified' });
  }
  if (posting?.confirmation?.status === 'confirmed') {
    if (posting.rules?.some((rule) => rule.confirmation_status === 'pending')) errors.push({ code: 'rules_still_pending' });
    if (posting.confirmation.structure_sha256 !== jobStructureHash(posting)) errors.push({ code: 'confirmed_structure_hash_mismatch' });
  }
  return { valid: errors.length === 0, errors };
}

export function confirmJobPosting(input, options = {}) {
  const candidate = structuredClone(input);
  candidate.confirmation = { status: 'pending', confirmed_at: null, structure_sha256: null };
  if (candidate.source?.kind === 'official_url') candidate.source.kind = 'public_url';
  if (candidate.source && ['public_url', 'official_url'].includes(candidate.source.kind)) {
    const confirmedOfficial = options.official_source_confirmed === true;
    candidate.source.kind = confirmedOfficial ? 'official_url' : 'public_url';
    candidate.source.official = confirmedOfficial;
    candidate.source.official_basis = confirmedOfficial ? 'user_confirmed' : 'unconfirmed';
    candidate.source.official_evidence = cleanText(options.official_source_evidence
      || (confirmedOfficial ? '用户已核对招聘单位域名或正式招聘平台' : '未确认官方来源'));
  }
  const posting = finalizeJobPosting(candidate);
  const pending = posting.rules.filter((rule) => rule.confirmation_status === 'pending').map((rule) => rule.id);
  if (pending.length) {
    const error = new Error('Every extracted job rule must be confirmed or rejected before evaluation');
    error.code = 'JOB_CONFIRMATION_INCOMPLETE';
    error.details = pending.map((id) => ({ code: 'rule_pending', id }));
    throw error;
  }
  posting.confirmation = {
    status: 'confirmed',
    confirmed_at: new Date().toISOString(),
    structure_sha256: null,
  };
  posting.confirmation.structure_sha256 = jobStructureHash(posting);
  const validation = validateJobPosting(posting);
  if (!validation.valid) {
    const error = new Error('Confirmed JobPosting validation failed');
    error.code = 'JOB_POSTING_INVALID';
    error.details = validation.errors;
    throw error;
  }
  return posting;
}

function profileValue(profile, field) {
  const structured = profile.schema_version === 2 ? profile.structured : null;
  if (!structured) return null;
  const education = structured.education || {};
  if (['degree', 'major_name', 'major_code', 'graduation_date', 'cohort', 'fresh_graduate_status'].includes(field)) return education[field] || null;
  if (field === 'language_certificate') return structured.language_certificates || [];
  if (field === 'credential') return structured.credentials || [];
  if (field === 'location') return structured.preferences?.locations || null;
  if (field === 'political_status') return structured.political_status || null;
  return null;
}

function compareScalar(actual, operator, expected) {
  if (operator === 'equals') return normalized(actual) === normalized(Array.isArray(expected) ? expected[0] : expected);
  if (operator === 'one_of') return (Array.isArray(expected) ? expected : [expected]).some((item) => normalized(actual) === normalized(item));
  if (operator === 'contains_any') return (Array.isArray(expected) ? expected : [expected]).some((item) => normalized(actual).includes(normalized(item)) || normalized(item).includes(normalized(actual)));
  if (operator === 'between') return Array.isArray(expected) && actual >= expected[0] && actual <= expected[1];
  if (operator === 'before_or_equal') return String(actual) <= String(expected);
  if (operator === 'at_least') {
    if (DEGREE_RANK[actual] && DEGREE_RANK[expected]) return DEGREE_RANK[actual] >= DEGREE_RANK[expected];
    return Number(actual) >= Number(expected);
  }
  return false;
}

function evaluateRule(profile, posting, rule) {
  if (!rule.explicit || !rule.source_quote || !posting.raw_text.includes(rule.source_quote)) {
    return { rule_id: rule.id, result: 'unknown', candidate_fact_ids: [], reason: '规则缺少可核对的招聘原文依据', source_quote: rule.source_quote || '' };
  }
  const candidate = profileValue(profile, rule.field);
  if (!candidate || (Array.isArray(candidate) && candidate.length === 0)) {
    return { rule_id: rule.id, result: 'unknown', candidate_fact_ids: [], reason: '候选人事实档案缺少该字段', source_quote: rule.source_quote };
  }
  let passed = false;
  let factIds = [];
  if (rule.field === 'language_certificate') {
    const expected = rule.expected || {};
    const matched = candidate.find((item) => normalized(item.kind) === normalized(expected.kind));
    if (!matched) {
      factIds = candidate.map((item) => item.fact_id);
      passed = false;
    } else {
      factIds = [matched.fact_id];
      passed = expected.minimum_score == null || Number(matched.score || 0) >= Number(expected.minimum_score);
    }
  } else if (rule.field === 'credential') {
    factIds = candidate.map((item) => item.fact_id);
    const names = candidate.map((item) => item.name);
    const expected = Array.isArray(rule.expected) ? rule.expected : [rule.expected];
    passed = expected.some((item) => names.some((name) => normalized(name).includes(normalized(item))));
  } else if (rule.field === 'location') {
    factIds = [candidate.fact_id];
    const actual = Array.isArray(candidate.value) ? candidate.value : [candidate.value];
    const expected = Array.isArray(rule.expected) ? rule.expected : [rule.expected];
    passed = expected.some((wanted) => actual.some((place) => normalized(place).includes(normalized(wanted)) || normalized(wanted).includes(normalized(place))));
  } else {
    factIds = [candidate.fact_id];
    passed = compareScalar(candidate.value, rule.operator, rule.expected);
  }
  return {
    rule_id: rule.id,
    result: passed ? 'satisfied' : 'failed',
    candidate_fact_ids: factIds,
    reason: passed ? '已由候选人事实与证据满足' : '候选人事实与招聘条件不一致',
    source_quote: rule.source_quote,
  };
}

export function evaluateEligibility(profile, posting) {
  const activeRules = posting.rules.filter((rule) => rule.confirmation_status === 'confirmed');
  const ruleResults = activeRules.map((rule) => evaluateRule(profile, posting, rule));
  const hard = activeRules.map((rule, index) => ({ rule, result: ruleResults[index] })).filter((item) => item.rule.severity === 'hard');
  const result = hard.some((item) => item.result.result === 'failed') ? 'ineligible'
    : hard.some((item) => item.result.result === 'unknown') ? 'unknown'
      : 'eligible';
  return { result, rule_results: ruleResults };
}

export function validateFitProposal(root, proposal) {
  const errors = [];
  if (!validateFitProposalSchema(proposal)) errors.push(...schemaErrors(validateFitProposalSchema));
  const dimensions = Array.isArray(proposal?.dimensions) ? proposal.dimensions : [];
  const ids = dimensions.map((item) => item?.id);
  if (new Set(ids).size !== Object.keys(FIT_WEIGHTS).length || Object.keys(FIT_WEIGHTS).some((id) => !ids.includes(id))) {
    errors.push({ code: 'fit_dimensions_incomplete_or_duplicate' });
  }
  const profile = loadCandidateProfile(root);
  const allowedFacts = profile.facts.filter((fact) => fact.status === 'confirmed'
    && fact.allowed_uses?.includes('job_match')
    && !['sensitive', 'restricted'].includes(fact.sensitivity));
  const allowedFactIds = new Set(allowedFacts.map((fact) => fact.id));
  for (const dimension of dimensions) {
    for (const factId of dimension?.candidate_fact_ids || []) {
      if (!allowedFactIds.has(factId)) errors.push({ code: 'fit_fact_not_allowed', fact_id: factId, dimension: dimension.id });
    }
  }
  const disallowedStatements = profile.facts
    .filter((fact) => !allowedFactIds.has(fact.id) && normalized(fact.statement).length >= 4)
    .map((fact) => ({ id: fact.id, value: normalized(fact.statement) }));
  const narratives = [
    ...dimensions.map((item) => ({ field: `dimensions.${item?.id}.rationale`, value: item?.rationale })),
    ...(proposal?.strengths || []).map((value, index) => ({ field: `strengths.${index}`, value })),
    ...(proposal?.gaps || []).map((value, index) => ({ field: `gaps.${index}`, value })),
  ];
  for (const narrative of narratives) {
    const value = normalized(narrative.value);
    for (const fact of disallowedStatements) {
      if (value && value.includes(fact.value)) {
        errors.push({ code: 'fit_narrative_uses_forbidden_fact', fact_id: fact.id, field: narrative.field });
      }
    }
  }
  if (errors.length) {
    const error = new Error('FitProposal validation failed');
    error.code = 'FIT_PROPOSAL_INVALID';
    error.details = errors;
    throw error;
  }
  return {
    dimensions: dimensions.map((item) => ({ ...item, rationale: safeNarrative(item.rationale) })),
    strengths: proposal.strengths.map(safeNarrative),
    gaps: proposal.gaps.map(safeNarrative),
  };
}

function sourceReliabilityCap(posting) {
  if (posting.source.kind === 'official_url' && posting.source.official === true && posting.source.official_basis !== 'unconfirmed') return 5;
  if (posting.source.kind === 'pdf' || posting.source.kind === 'docx') return 4;
  return 3;
}

function buildFit(profile, posting, proposals = []) {
  const confirmedFactIds = new Set(profile.facts.filter((fact) => fact.status === 'confirmed'
    && fact.allowed_uses?.includes('job_match')
    && !['sensitive', 'restricted'].includes(fact.sensitivity)).map((fact) => fact.id));
  const byId = new Map(proposals.map((item) => [item.id, item]));
  const dimensions = Object.entries(FIT_WEIGHTS).map(([id, weight]) => {
    const proposal = byId.get(id) || {};
    const candidateFactIds = [...new Set((proposal.candidate_fact_ids || []).filter((factId) => confirmedFactIds.has(factId)))];
    let score = Number.isFinite(proposal.score) ? Math.max(0, Math.min(5, proposal.score)) : 3;
    if (id === 'source_reliability') score = Math.min(score, sourceReliabilityCap(posting));
    return { id, score, weight, candidate_fact_ids: candidateFactIds, rationale: safeNarrative(proposal.rationale || '待结合已确认事实进一步分析') };
  });
  const score = Math.round(dimensions.reduce((sum, item) => sum + item.score * item.weight, 0) * 100) / 100;
  return { score, dimensions };
}

function recommendationFor(posting, eligibility, fit, override) {
  if (posting.posting_status === 'closed' || posting.posting_status === 'expired') return 'do_not_apply';
  if (eligibility.result === 'unknown') return 'need_more_info';
  if (eligibility.result === 'ineligible') return override ? 'consider' : 'do_not_apply';
  if (fit.score >= 4) return 'apply';
  if (fit.score >= 3.5) return 'consider';
  return 'do_not_apply';
}

export function evaluateJob(root, posting, options = {}) {
  const jobValidation = validateJobPosting(posting);
  if (!jobValidation.valid) {
    const error = new Error('JobPosting validation failed');
    error.code = 'JOB_POSTING_INVALID';
    error.details = jobValidation.errors;
    throw error;
  }
  if (posting.confirmation.status !== 'confirmed') {
    const error = new Error('JobPosting must be explicitly confirmed before evaluation');
    error.code = 'JOB_NOT_CONFIRMED';
    error.details = posting.rules.filter((rule) => rule.confirmation_status === 'pending').map((rule) => ({ code: 'rule_pending', id: rule.id }));
    throw error;
  }
  const profile = loadCandidateProfile(root);
  const eligibility = evaluateEligibility(profile, posting);
  const override = options.override_reason
    ? { reason: safeNarrative(options.override_reason), recorded_at: new Date().toISOString() }
    : null;
  if (override && eligibility.result === 'eligible') throw new Error('Eligibility override is only allowed for unknown or ineligible results');
  const suppliedProposal = options.dimensions !== undefined || options.strengths !== undefined || options.gaps !== undefined;
  const proposal = suppliedProposal
    ? validateFitProposal(root, {
        dimensions: options.dimensions || [],
        strengths: options.strengths || [],
        gaps: options.gaps || [],
      })
    : {
        dimensions: Object.keys(FIT_WEIGHTS).map((id) => ({ id, score: 3, candidate_fact_ids: [], rationale: '未使用 AI 建议，采用中性基线' })),
        strengths: [],
        gaps: [],
      };
  const fit = buildFit(profile, posting, proposal.dimensions);
  const jobHash = sha256(stableJson(posting));
  const profilePath = join(root, 'profile', 'candidate.yml');
  const profileHash = existsSync(profilePath) ? sha256(readFileSync(profilePath)) : sha256(stableJson(profile));
  const reportPath = join('reports', 'careerpilot', `${posting.id}.md`).replaceAll('\\', '/');
  const report = {
    schema_version: 1,
    id: `match.${sha256(`${posting.id}|${profileHash}`).slice(0, 24)}`,
    job_id: posting.id,
    job_sha256: jobHash,
    profile_sha256: profileHash,
    evaluated_at: new Date().toISOString(),
    eligibility,
    fit,
    recommendation: recommendationFor(posting, eligibility, fit, override),
    strengths: proposal.strengths,
    gaps: proposal.gaps,
    override,
    report_path: reportPath,
  };
  const validation = validateMatchReport(report);
  if (!validation.valid) {
    const error = new Error('MatchReport validation failed');
    error.code = 'MATCH_REPORT_INVALID';
    error.details = validation.errors;
    throw error;
  }
  return report;
}

export function validateMatchReport(report) {
  const errors = [];
  if (!validateMatchSchema(report)) errors.push(...schemaErrors(validateMatchSchema));
  const dimensions = report?.fit?.dimensions || [];
  const ids = dimensions.map((item) => item.id);
  if (new Set(ids).size !== Object.keys(FIT_WEIGHTS).length || Object.keys(FIT_WEIGHTS).some((id) => !ids.includes(id))) {
    errors.push({ code: 'fit_dimensions_incomplete' });
  }
  for (const dimension of dimensions) {
    if (dimension.weight !== FIT_WEIGHTS[dimension.id]) errors.push({ code: 'fit_weight_mismatch', id: dimension.id });
  }
  const expectedScore = Math.round(dimensions.reduce((sum, item) => sum + item.score * item.weight, 0) * 100) / 100;
  if (Number.isFinite(report?.fit?.score) && report.fit.score !== expectedScore) errors.push({ code: 'fit_score_mismatch' });
  return { valid: errors.length === 0, errors };
}

function renderMatchMarkdown(posting, report) {
  const recommendation = { apply: '建议申请', consider: '谨慎考虑', do_not_apply: '不建议申请', need_more_info: '先补资料' }[report.recommendation];
  const eligibility = { eligible: '符合', ineligible: '不符合', unknown: '信息不足' }[report.eligibility.result];
  const lines = [
    `# ${posting.employer.name}｜${posting.title}`,
    '',
    `- 岗位 ID：${posting.id}`,
    `- 来源：${posting.source.kind}${posting.source.ref ? `（${posting.source.ref}）` : ''}`,
    `- 资格结论：${eligibility}`,
    `- 匹配分：${report.fit.score.toFixed(2)}/5`,
    `- 建议：${recommendation}`,
    '',
    '## 资格规则',
    '',
  ];
  for (const item of report.eligibility.rule_results) {
    lines.push(`- ${item.result}｜${item.reason}｜原文：${item.source_quote || '无明确原文'}｜事实：${item.candidate_fact_ids.join(', ') || '待补充'}`);
  }
  lines.push('', '## 匹配维度', '');
  for (const item of report.fit.dimensions) lines.push(`- ${item.id}：${item.score}/5（权重 ${Math.round(item.weight * 100)}%）｜${item.rationale}`);
  if (report.override) lines.push('', '## 人工覆盖', '', `- 原因：${report.override.reason}`, `- 时间：${report.override.recorded_at}`);
  if (report.strengths.length) lines.push('', '## 优势', '', ...report.strengths.map((item) => `- ${item}`));
  if (report.gaps.length) lines.push('', '## 待补信息或差距', '', ...report.gaps.map((item) => `- ${item}`));
  return `${lines.join('\n').trimEnd()}\n`;
}

export function saveJobEvaluation(root, posting, report) {
  const jobValidation = validateJobPosting(posting);
  const reportValidation = validateMatchReport(report);
  if (!jobValidation.valid || !reportValidation.valid) throw new Error('Cannot persist invalid job evaluation');
  const actualJobHash = sha256(stableJson(posting));
  if (report.job_id !== posting.id || report.job_sha256 !== actualJobHash) throw new Error('MatchReport does not belong to the supplied JobPosting');
  const jobPath = join(root, 'data', 'careerpilot', 'jobs', `${posting.id}.json`);
  const matchPath = join(root, 'data', 'careerpilot', 'matches', `${posting.id}.json`);
  const reportPath = join(root, report.report_path);
  atomicWrite(jobPath, `${JSON.stringify(posting, null, 2)}\n`);
  atomicWrite(matchPath, `${JSON.stringify(report, null, 2)}\n`);
  atomicWrite(reportPath, renderMatchMarkdown(posting, report));
  return { job_path: jobPath, match_path: matchPath, report_path: reportPath };
}

export function loadJobEvaluation(root, jobId) {
  if (!/^job\.[a-f0-9]{16,64}$/.test(jobId)) throw new Error('Invalid job ID');
  const jobPath = join(root, 'data', 'careerpilot', 'jobs', `${jobId}.json`);
  const matchPath = join(root, 'data', 'careerpilot', 'matches', `${jobId}.json`);
  if (!existsSync(jobPath) || !existsSync(matchPath)) throw new Error(`Job evaluation not found: ${jobId}`);
  const posting = JSON.parse(readFileSync(jobPath, 'utf8'));
  const report = JSON.parse(readFileSync(matchPath, 'utf8'));
  const jobValidation = validateJobPosting(posting);
  const reportValidation = validateMatchReport(report);
  if (!jobValidation.valid || !reportValidation.valid) throw new Error(`Stored job evaluation is invalid: ${jobId}`);
  const relativeJob = relative(root, jobPath);
  if (relativeJob.startsWith('..') || isAbsolute(relativeJob)) throw new Error('Stored job path escaped the workspace');
  return { posting, report };
}
