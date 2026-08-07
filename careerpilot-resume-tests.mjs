#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';
import yaml from 'js-yaml';
import {
  confirmResumeVariant,
  createResumeVariant,
  exportResume,
  renderResumeDocx,
  renderResumeHtml,
  renderAnonymousResumeStylePreview,
  renderResumeMarkdown,
  validateResumeVariant,
} from './lib/careerpilot/resume-core.mjs';
import { getResumeStyleCatalog } from './lib/careerpilot/resume-style-core.mjs';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

const root = mkdtempSync(join(tmpdir(), 'careerpilot-resume-'));
mkdirSync(join(root, 'profile'), { recursive: true });
const fixture = yaml.load(readFileSync(join(import.meta.dirname, 'examples', 'cn-profile', 'candidate.yml'), 'utf8'));
fixture.candidate.photo = 'profile/evidence/photo.png';
fixture.candidate.political_status = '共青团员';
fixture.facts.push({
  id: 'campus.student.union',
  type: 'campus',
  statement: '负责学生组织活动协调；整理活动材料',
  status: 'confirmed',
  sensitivity: 'personal',
  allowed_uses: ['resume', 'application_form'],
  evidence_ids: ['evidence.campus.confirmation'],
  source: 'anonymous-fixture',
}, {
  id: 'award.unconfirmed',
  type: 'award',
  statement: '未核验奖项不得发布',
  status: 'unconfirmed',
  sensitivity: 'personal',
  allowed_uses: ['resume'],
  evidence_ids: [],
  source: 'anonymous-fixture',
}, {
  id: 'basic.forbidden.address',
  type: 'basic',
  subtype: 'city_region',
  statement: '家庭住址：某省某市某路 1 号',
  status: 'confirmed',
  sensitivity: 'restricted',
  allowed_uses: ['resume'],
  evidence_ids: ['evidence.address.confirmation'],
  source: 'anonymous-fixture',
}, {
  id: 'basic.unlabelled.address',
  type: 'basic',
  subtype: 'city_region',
  statement: '北京市海淀区中关村大街 27 号',
  status: 'confirmed',
  sensitivity: 'restricted',
  allowed_uses: ['resume'],
  evidence_ids: ['evidence.address.confirmation'],
  source: 'anonymous-fixture',
});
fixture.evidence.push({
  id: 'evidence.campus.confirmation',
  kind: 'user_confirmation',
  ref: 'confirmation:anonymous-campus',
  strength: 'ordinary',
  verified_at: '2026-07-27T12:00:00.000Z',
}, {
  id: 'evidence.address.confirmation',
  kind: 'user_confirmation',
  ref: 'confirmation:anonymous-address',
  strength: 'ordinary',
  verified_at: '2026-07-27T12:00:00.000Z',
});
writeFileSync(join(root, 'profile', 'candidate.yml'), yaml.dump(fixture), 'utf8');
mkdirSync(join(root, 'profile', 'evidence'), { recursive: true });
writeFileSync(join(root, 'profile', 'evidence', 'photo.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));

const templates = ['soe-one-page', 'tech-two-page', 'application-detail'];
const variants = templates.map((template) => createResumeVariant(root, { template }));

test('三种内容策略预览共享匿名内容模型并保留 Fact 标记', () => {
  const catalog = getResumeStyleCatalog(root);
  for (const definition of catalog.styles) {
    const html = renderAnonymousResumeStylePreview(root, {
      ...structuredClone(definition.defaults),
      schema_version: 2,
      theme: definition.id,
    });
    assert.match(html, /示例候选人/);
    assert.match(html, /data-fact-id="preview\./);
    assert.match(html, new RegExp(`resume-theme-${definition.id}`));
    assert.match(html, new RegExp(definition.palette.accent.slice(1), 'i'));
    assert.doesNotMatch(html, new RegExp(fixture.candidate.display_name));
  }
});

test('内容强调轴会确定性改变区块顺序而不增删 Fact', () => {
  const definition = getResumeStyleCatalog(root).styles.find((item) => item.id === 'soe-outcome');
  const base = { ...structuredClone(definition.defaults), schema_version: 2, theme: definition.id };
  const technical = renderAnonymousResumeStylePreview(root, { ...base, emphasis: 'technical' });
  const campus = renderAnonymousResumeStylePreview(root, { ...base, emphasis: 'campus' });
  assert.ok(technical.indexOf('实习与工作经历') < technical.indexOf('教育经历'));
  assert.ok(campus.indexOf('校园经历') < campus.indexOf('项目经历'));
  assert.equal((technical.match(/data-fact-id=/g) || []).length, (campus.match(/data-fact-id=/g) || []).length);
});

test('主简历只能由实际预览草稿显式确认进入 ready，确认后变更会失效', () => {
  const draft = createResumeVariant(root, { template: 'soe-one-page' });
  assert.equal(draft.status, 'draft');
  const { variant } = confirmResumeVariant(root, draft);
  assert.equal(variant.status, 'ready');
  assert.equal(variant.confirmation.status, 'confirmed');
  assert.match(variant.confirmation.preview_sha256, /^[a-f0-9]{64}$/);
  assert.match(variant.source_resume_style_sha256, /^[a-f0-9]{64}$/);
  const changed = structuredClone(variant);
  changed.order = [...changed.order].reverse();
  assert.ok(validateResumeVariant(root, changed).errors.some((item) => item.code === 'confirmed_preview_hash_mismatch'));

  const red = getResumeStyleCatalog(root).styles.find((item) => item.id === 'research-academic');
  const stylePath = join(root, 'profile', 'resume-style.yml');
  writeFileSync(stylePath, yaml.dump({ ...structuredClone(red.defaults), schema_version: 2, theme: red.id }), 'utf8');
  assert.ok(validateResumeVariant(root, variant).errors.some((item) => item.code === 'resume_style_changed_since_preview'));
  rmSync(stylePath, { force: true });
  assert.equal(validateResumeVariant(root, variant).valid, true);
});

test('三类模板均只采用通过发布门槛的事实', () => {
  for (const variant of variants) {
    assert.equal(validateResumeVariant(root, variant).valid, true);
    assert.ok(!variant.fact_ids.includes('award.unconfirmed'));
    assert.deepEqual(new Set(variant.fact_ids), new Set(variants[0].fact_ids));
  }
});

test('三类模板用排序体现不同侧重点', () => {
  assert.notDeepEqual(variants[0].order, variants[1].order);
  assert.notDeepEqual(variants[1].order, variants[2].order);
});

test('未经接受的候选改写不能进入正式版本', () => {
  const variant = structuredClone(variants[0]);
  variant.rewrites.push({ fact_id: variant.fact_ids[0], proposed_statement: '未经接受的改写', accepted: false });
  const validation = validateResumeVariant(root, variant);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((item) => item.code === 'rewrite_not_accepted'));
});

test('已接受改写也不能引入原 Fact 中不存在的新词或数字', () => {
  const variant = structuredClone(variants[1]);
  variant.rewrites.push({ fact_id: 'project.campus.platform', proposed_statement: '完成匿名校园服务平台并提升效率 90%', accepted: true });
  assert.ok(validateResumeVariant(root, variant).errors.some((item) => item.code === 'rewrite_introduces_new_claim'));
});

test('受控改写允许完整分句重排但不增删事实词项', () => {
  const variant = createResumeVariant(root, {
    template: 'soe-one-page',
    rewrites: [{ fact_id: 'campus.student.union', proposed_statement: '整理活动材料；负责学生组织活动协调', accepted: true }],
  });
  assert.equal(validateResumeVariant(root, variant).valid, true);
  assert.match(renderResumeMarkdown(root, variant), /整理活动材料；负责学生组织活动协调/);
});

test('改写不能通过删去否定词反转原事实', () => {
  const profile = yaml.load(readFileSync(join(root, 'profile', 'candidate.yml'), 'utf8'));
  profile.facts.push({
    id: 'skill.negative.java', type: 'skill', statement: '不熟悉 Java', status: 'confirmed', sensitivity: 'personal',
    allowed_uses: ['resume'], evidence_ids: ['evidence.campus.confirmation'], source: 'anonymous-fixture',
  });
  writeFileSync(join(root, 'profile', 'candidate.yml'), yaml.dump(profile), 'utf8');
  const variant = createResumeVariant(root, { template: 'tech-two-page' });
  variant.rewrites.push({ fact_id: 'skill.negative.java', proposed_statement: '熟悉 Java', accepted: true });
  variant.diff.rewritten.push({ fact_id: 'skill.negative.java', statement: '熟悉 Java' });
  assert.ok(validateResumeVariant(root, variant).errors.some((item) => item.code === 'rewrite_introduces_new_claim'));
  profile.facts.pop();
  writeFileSync(join(root, 'profile', 'candidate.yml'), yaml.dump(profile), 'utf8');
});

test('排序列表必须与采用的 Fact IDs 完全一致', () => {
  const variant = structuredClone(variants[0]);
  variant.order.pop();
  assert.ok(validateResumeVariant(root, variant).errors.some((item) => item.code === 'order_mismatch'));
});

test('禁止字段不能通过敏感授权进入简历', () => {
  const variant = structuredClone(variants[0]);
  variant.sensitive_authorizations.identity_number = true;
  const validation = validateResumeVariant(root, variant);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((item) => item.code === 'forbidden_sensitive_field'));
});

test('照片与政治面貌只在当前 ResumeVariant 显式授权后出现', () => {
  const privateVariant = createResumeVariant(root, { template: 'soe-one-page' });
  assert.doesNotMatch(renderResumeHtml(root, privateVariant), /候选人照片|政治面貌/);
  const authorized = createResumeVariant(root, {
    template: 'soe-one-page',
    sensitive_authorizations: { photo: true, political_status: true },
  });
  const html = renderResumeHtml(root, authorized);
  assert.match(html, /data:image\/png;base64/);
  assert.match(html, /政治面貌：共青团员/);
});

test('Markdown 与 HTML 均保留 Fact 追踪标记且不包含未确认事实', () => {
  const markdown = renderResumeMarkdown(root, variants[1]);
  const html = renderResumeHtml(root, variants[1]);
  for (const id of variants[1].fact_ids) {
    assert.match(markdown, new RegExp(`fact:${id.replaceAll('.', '\\.')}`));
    assert.match(html, new RegExp(`data-fact-id="${id.replaceAll('.', '\\.')}"`));
  }
  assert.doesNotMatch(markdown, /未核验奖项/);
  assert.doesNotMatch(html, /未核验奖项/);
  assert.doesNotMatch(markdown, /家庭住址|anonymous@example\.invalid/);
  assert.doesNotMatch(html, /家庭住址|anonymous@example\.invalid/);
  assert.doesNotMatch(markdown, /中关村大街/);
  assert.doesNotMatch(html, /中关村大街/);
});

test('初始差异审计完整列出展示、删除和排序', () => {
  const variant = variants[2];
  assert.deepEqual(variant.diff.added, variant.fact_ids);
  assert.ok(variant.diff.removed.includes('award.unconfirmed'));
  assert.equal(variant.diff.rewritten.length, 0);
  const trulyMoved = variant.order.filter((id, index) => variant.fact_ids[index] !== id);
  assert.equal(variant.diff.reordered.length, trulyMoved.length);
});

test('客户端不能伪造或清空差异审计', () => {
  const variant = structuredClone(variants[1]);
  variant.diff.reordered = [];
  assert.ok(validateResumeVariant(root, variant).errors.some((item) => item.code === 'diff_mismatch'));
});

test('照片内容在预览后被哈希锁定', () => {
  const variant = createResumeVariant(root, { template: 'soe-one-page', sensitive_authorizations: { photo: true } });
  const path = join(root, 'profile', 'evidence', 'photo.png');
  const original = readFileSync(path);
  writeFileSync(path, Buffer.concat([original, Buffer.from('changed')]));
  assert.ok(validateResumeVariant(root, variant).errors.some((item) => item.code === 'photo_changed_since_preview'));
  writeFileSync(path, original);
});

test('照片符号链接不能越过证据目录', () => {
  const profilePath = join(root, 'profile', 'candidate.yml');
  const profile = yaml.load(readFileSync(profilePath, 'utf8'));
  const outside = join(root, 'outside.png');
  const linked = join(root, 'profile', 'evidence', 'linked.png');
  writeFileSync(outside, readFileSync(join(root, 'profile', 'evidence', 'photo.png')));
  try {
    symlinkSync(outside, linked, 'file');
  } catch (error) {
    if (error.code === 'EPERM') return;
    throw error;
  }
  profile.candidate.photo = 'profile/evidence/linked.png';
  writeFileSync(profilePath, yaml.dump(profile), 'utf8');
  assert.throws(() => createResumeVariant(root, { template: 'soe-one-page', sensitive_authorizations: { photo: true } }), /validation failed/);
  profile.candidate.photo = 'profile/evidence/photo.png';
  writeFileSync(profilePath, yaml.dump(profile), 'utf8');
});

test('证据根目录本身不能是指向外部目录的 junction 或 symlink', () => {
  const linkedRoot = mkdtempSync(join(tmpdir(), 'careerpilot-linked-evidence-'));
  const outsideEvidence = join(linkedRoot, 'outside-evidence');
  mkdirSync(join(linkedRoot, 'profile'), { recursive: true });
  mkdirSync(outsideEvidence, { recursive: true });
  writeFileSync(join(outsideEvidence, 'photo.png'), readFileSync(join(root, 'profile', 'evidence', 'photo.png')));
  try {
    symlinkSync(outsideEvidence, join(linkedRoot, 'profile', 'evidence'), platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (error.code === 'EPERM') return;
    throw error;
  }
  const linkedProfile = structuredClone(fixture);
  linkedProfile.candidate.photo = 'profile/evidence/photo.png';
  linkedProfile.facts = [];
  linkedProfile.evidence = [];
  writeFileSync(join(linkedRoot, 'profile', 'candidate.yml'), yaml.dump(linkedProfile), 'utf8');
  assert.throws(() => createResumeVariant(linkedRoot, { template: 'soe-one-page', sensitive_authorizations: { photo: true } }), /validation failed/);
});

const docxBuffer = await renderResumeDocx(root, variants[1]);
const JSZip = (await import('jszip')).default;
const archive = await JSZip.loadAsync(docxBuffer);
const documentXml = await archive.file('word/document.xml').async('string');
assert.match(documentXml, /完成匿名校园服务平台的接口设计与功能实现/);
assert.match(documentXml, /fact:project\.campus\.platform/);
assert.match(documentXml, /Microsoft YaHei/);
console.log('PASS DOCX 是可编辑的结构化 Word 文档并保留 Fact 标记');
passed += 1;

writeFileSync(join(root, 'profile', 'resume-style.yml'), yaml.dump({
  schema_version: 2,
  theme: 'soe-outcome',
  density: 'full',
  page_budget: 1,
  emphasis: 'general',
  font_family: 'Microsoft YaHei',
  font_size_pt: 9.5,
  page_margin_cm: 0.9,
  section_order: ['教育经历', '专业技能', '项目经历', '证书与奖项', '基本信息'],
  project_bullet_limit: 4,
  photo: { enabled: true, crop: 'center-3x4', width_cm: 2.4, height_cm: 3.2 },
}), 'utf8');
const styledDocx = await renderResumeDocx(root, createResumeVariant(root, {
  template: 'soe-one-page',
  target_job_title: '匿名信息技术岗',
  sensitive_authorizations: { photo: true },
}));
const styledArchive = await JSZip.loadAsync(styledDocx);
const styledXml = await styledArchive.file('word/document.xml').async('string');
assert.match(styledXml, /<w:tbl>/);
assert.match(styledXml, /求职方向：匿名信息技术岗/);
assert.match(styledXml, /w:sz w:val="19"/);
rmSync(join(root, 'profile', 'resume-style.yml'), { force: true });
console.log('PASS 头像轴 DOCX 使用双列头部并应用央国企成果导向主题');
passed += 1;

await assert.rejects(
  () => exportResume(root, variants[0], 'md', 'output/careerpilot/unconfirmed.md'),
  (error) => error.code === 'RESUME_NOT_CONFIRMED',
);
console.log('PASS 未确认主简历无法从核心或 CLI 导出');
passed += 1;

const confirmedExportVariant = confirmResumeVariant(root, variants[0]).variant;
const markdownExport = await exportResume(root, confirmedExportVariant, 'md', 'output/careerpilot/anonymous-soe.md');
assert.ok(existsSync(markdownExport.path));
assert.ok(existsSync(`${markdownExport.path}.manifest.json`));
assert.equal(JSON.parse(readFileSync(`${markdownExport.path}.manifest.json`, 'utf8')).fact_ids.length, confirmedExportVariant.fact_ids.length);
console.log('PASS 导出采用正式文件与追踪 manifest 的原子发布');
passed += 1;

const blockedOutput = join(root, 'output', 'careerpilot', 'blocked.md');
mkdirSync(`${blockedOutput}.manifest.json`, { recursive: true });
await assert.rejects(() => exportResume(root, confirmedExportVariant, 'md', 'output/careerpilot/blocked.md'), /already exists/);
assert.equal(existsSync(blockedOutput), false);
console.log('PASS manifest 发布失败前不会留下正式简历文件');
passed += 1;

await assert.rejects(() => exportResume(root, confirmedExportVariant, 'md', 'output/careerpilot/anonymous-soe.md'), /already exists/);
console.log('PASS 已发布导出不可静默覆盖');
passed += 1;

const cleanupVariant = confirmResumeVariant(root, createResumeVariant(root, { template: 'soe-one-page' })).variant;
const cleanupExport = await exportResume(root, cleanupVariant, 'md', 'output/careerpilot/cleanup-warning.md', {
  beforeCommittedCleanup() { throw new Error('simulated antivirus lock'); },
});
assert.ok(existsSync(cleanupExport.path));
assert.ok(existsSync(`${cleanupExport.path}.manifest.json`));
console.log('PASS 正式提交后的临时清理失败不会把成功误报为失败');
passed += 1;

const profilePath = join(root, 'profile', 'candidate.yml');
const originalProfile = readFileSync(profilePath, 'utf8');
const changedProfile = yaml.load(originalProfile);
changedProfile.candidate.display_name = '资料已变更';
writeFileSync(profilePath, yaml.dump(changedProfile), 'utf8');
assert.ok(validateResumeVariant(root, variants[0]).errors.some((item) => item.code === 'profile_changed_since_preview'));
writeFileSync(profilePath, originalProfile, 'utf8');
console.log('PASS 导出拒绝事实资料在预览后发生漂移');
passed += 1;

if (platform === 'win32') {
  await assert.rejects(() => exportResume(root, confirmedExportVariant, 'md', 'Z:\\careerpilot-escape.md'), /output\/careerpilot/);
  console.log('PASS Windows 跨盘绝对路径不能绕过导出目录');
  passed += 1;
}

console.log(`\n${passed} resume tests passed`);
