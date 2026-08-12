import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const webRoot = import.meta.dirname;
const repoRoot = resolve(webRoot, '..');
const dataRoot = mkdtempSync(join(tmpdir(), 'careerpilot-web-api-'));
const port = 19_500 + Math.floor(Math.random() * 1_000);
const baseUrl = `http://127.0.0.1:${port}`;
let server;
let serverOutput = '';

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/candidate-profile`);
      if (response.status !== 404) return;
    } catch {
      // Dev server is still compiling.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Next test server did not start: ${serverOutput.slice(-1000)}`);
}

async function assertStatus(response, expected = 200) {
  if (response.status !== expected) {
    assert.fail(`expected HTTP ${expected}, received ${response.status}: ${await response.text()}`);
  }
}

async function confirmResumeDraft(variant) {
  const response = await fetch(`${baseUrl}/api/cn/resumes/baselines`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ variant, confirmed: true }),
  });
  await assertStatus(response);
  return (await response.json()).variant;
}

before(async () => {
  const canonicalCli = pathToFileURL(join(repoRoot, 'careerpilot.mjs')).href;
  writeFileSync(join(dataRoot, 'careerpilot.mjs'), `import ${JSON.stringify(canonicalCli)};\n`, 'utf8');
  writeFileSync(join(dataRoot, 'cv.md'), '# 旧版匿名简历\n\n- 尚未迁移的内容\n', 'utf8');
  server = spawn(process.execPath, [join(webRoot, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: webRoot,
    env: { ...process.env, CAREER_OPS_ROOT: dataRoot, NEXT_TELEMETRY_DISABLED: '1', BUILD_DIST: `.next-test-${port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => (serverOutput += chunk.toString()));
  server.stderr.on('data', (chunk) => (serverOutput += chunk.toString()));
  await waitForServer();
}, { timeout: 30_000 });

after(() => {
  server?.kill('SIGTERM');
});

test('legacy cv.md remains visible until CandidateProfile migration', async () => {
  const response = await fetch(`${baseUrl}/api/cv`);
  const body = await response.json();
  assert.equal(body.generated, false);
  assert.match(body.content, /旧版匿名简历/);
});

test('Web API uses the canonical profile workflow and keeps /api/cv read-only', async () => {
  const content = '# 匿名候选人\n\n## 项目经历\n\n- 完成匿名校园项目\n';
  let response = await fetch(`${baseUrl}/api/candidate-profile/import-cv`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).imported, 1);

  response = await fetch(`${baseUrl}/api/candidate-profile`);
  const profile = await response.json();
  const factId = profile.facts[0].id;
  assert.equal(profile.facts[0].status, 'unconfirmed');

  response = await fetch(`${baseUrl}/api/candidate-profile/evidence`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fact_id: factId,
      id: 'evidence.web.confirmation',
      kind: 'user_confirmation',
      ref: 'confirmation:web-e2e',
      strength: 'ordinary',
    }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/candidate-profile/fact-status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: factId, status: 'confirmed' }),
  });
  assert.equal(response.status, 200);

  response = await fetch(`${baseUrl}/api/candidate-profile/project-cv`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.match((await response.json()).markdown, /完成匿名校园项目/);

  response = await fetch(`${baseUrl}/api/cv`);
  const generated = await response.json();
  assert.equal(generated.generated, true);
  assert.match(generated.content, /<!-- fact:/);

  response = await fetch(`${baseUrl}/api/cv`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'attempted overwrite' }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'CV_READ_ONLY');
}, { timeout: 30_000 });

test('failed Web validation does not mutate the canonical profile', async () => {
  const beforeResponse = await fetch(`${baseUrl}/api/candidate-profile`);
  const beforeProfile = await beforeResponse.json();
  const response = await fetch(`${baseUrl}/api/candidate-profile/evidence`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fact_id: beforeProfile.facts[0].id, kind: 'document' }),
  });
  assert.equal(response.status, 400);
  const afterProfile = await (await fetch(`${baseUrl}/api/candidate-profile`)).json();
  assert.deepEqual(afterProfile, beforeProfile);
}, { timeout: 30_000 });

test('项目面试 API 公开可信简历目录并在启动 AI 前校验请求', async () => {
  let response = await fetch(`${baseUrl}/api/cn/interviews/projects`);
  await assertStatus(response);
  const catalog = await response.json();
  assert.equal(catalog.schema_version, 1);
  assert.ok(Array.isArray(catalog.sources));

  response = await fetch(`${baseUrl}/api/cn/interviews/projects/pack`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /简历|项目|AI/);

  response = await fetch(`${baseUrl}/api/cn/interviews/projects/review`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /简历|项目|问题|回答|AI/);

  response = await fetch(`${baseUrl}/api/cn/interviews/projects/pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source_id: {}, project_id: 'project_alpha', target_role: {}, cliId: 'claude' }),
  });
  assert.equal(response.status, 400, '非字符串字段必须在启动 AI 前拒绝');

  response = await fetch(`${baseUrl}/api/cn/interviews/projects/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source_id: 'source', project_id: 'project_alpha', question: {}, answer: [], cliId: 'claude',
    }),
  });
  assert.equal(response.status, 400, '问题和回答不得依赖可选链调用规避类型检查');

  response = await fetch(`${baseUrl}/api/cn/interviews/projects/pack`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(70_000) }),
  });
  assert.equal(response.status, 413, '项目面试 API 必须在 JSON 解析前限制请求体');
}, { timeout: 30_000 });

test('Web ResumeVariant preview uses canonical Facts and sparse DOCX is rejected by render QA', async () => {
  let response = await fetch(`${baseUrl}/api/resume-variants/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ template: 'tech-two-page' }),
  });
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.variant.template, 'tech-two-page');
  assert.match(preview.markdown, /完成匿名校园项目/);
  assert.match(preview.html, /data-fact-id=/);
  const confirmedPreview = await confirmResumeDraft(preview.variant);

  response = await fetch(`${baseUrl}/api/resume-variants/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ variant: confirmedPreview, format: 'md' }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/markdown/);
  assert.match(await response.text(), /<!-- fact:/);

  const applicationDetailDraft = (await (await fetch(`${baseUrl}/api/resume-variants/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ template: 'application-detail' }),
  })).json()).variant;
  const applicationDetail = await confirmResumeDraft(applicationDetailDraft);
  response = await fetch(`${baseUrl}/api/resume-variants/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      variant: applicationDetail,
      format: 'docx',
    }),
  });
  assert.equal(response.status, 400);
  const sparseDocx = await response.json();
  assert.ok(['RESUME_TEXT_LAYER_INVALID', 'RESUME_ABNORMAL_WHITESPACE'].includes(sparseDocx.code));

  const factId = preview.variant.fact_ids[0];
  response = await fetch(`${baseUrl}/api/candidate-profile/fact-status`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: factId, status: 'rejected' }),
  });
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/api/resume-variants/export`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ variant: confirmedPreview, format: 'md' }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /validation failed/i);
}, { timeout: 30_000 });

test('Web resume strategy API exposes three content strategies and persists independent presentation axes', async () => {
  let response = await fetch(`${baseUrl}/api/cn/resumes/style`);
  await assertStatus(response);
  const initial = await response.json();
  assert.equal(initial.catalog.styles.length, 3);
  assert.equal(initial.catalog.editorial_policy.source_scope, 'reference_layout_and_editorial_patterns_only');
  assert.deepEqual(initial.catalog.content_strategies.strategies.map((item) => item.id), ['soe-outcome', 'internet-engineering', 'research-academic']);
  assert.ok(initial.catalog.styles.every((item) => item.preview_html.includes('data-fact-id="preview.')));
  assert.equal(initial.catalog.content_strategies.strategies[0].experience_formula.length, 4);

  const red = initial.catalog.styles.find((item) => item.id === 'research-academic');
  const style = {
    ...red.defaults,
    schema_version: 2,
    theme: red.id,
    density: 'full',
    page_budget: 2,
    emphasis: 'campus',
    photo: { ...red.defaults.photo, enabled: false },
  };
  response = await fetch(`${baseUrl}/api/cn/resumes/style-preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(style),
  });
  await assertStatus(response);
  const preview = await response.json();
  assert.match(preview.html, /resume-theme-research-academic/);
  assert.ok(preview.html.indexOf('校园经历') < preview.html.indexOf('项目经历'));

  response = await fetch(`${baseUrl}/api/cn/resumes/style`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(style),
  });
  await assertStatus(response);
  const saved = await response.json();
  assert.equal(saved.style.theme, 'research-academic');
  assert.equal(saved.style.density, 'full');
  assert.equal(saved.style.page_budget, 2);
  assert.equal(saved.style.emphasis, 'campus');
  assert.equal(saved.style.photo.enabled, false);
}, { timeout: 30_000 });

test('Web profile evidence upload stores a verified local document with a content hash', async () => {
  const beforeProfile = await (await fetch(`${baseUrl}/api/candidate-profile`)).json();
  const form = new FormData();
  form.set('fact_id', beforeProfile.facts[0].id);
  form.set('file', new File([Buffer.from('%PDF-1.4\n% anonymous evidence\n')], 'proof.pdf', { type: 'application/pdf' }));
  const response = await fetch(`${baseUrl}/api/candidate-profile/evidence`, { method: 'POST', body: form });
  await assertStatus(response);
  const result = await response.json();
  assert.equal(result.evidence.kind, 'document');
  assert.equal(result.evidence.strength, 'strong');
  assert.match(result.evidence.ref, /^profile\/evidence\/imports\/[a-f0-9-]+\.pdf$/);
  assert.match(result.evidence.sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result), /careerpilot-web-api-/);

  const oversized = new FormData();
  oversized.set('fact_id', beforeProfile.facts[0].id);
  oversized.set('file', new File([Buffer.alloc(10 * 1024 * 1024 + 1)], 'too-large.pdf', { type: 'application/pdf' }));
  assert.equal((await fetch(`${baseUrl}/api/candidate-profile/evidence`, { method: 'POST', body: oversized })).status, 413);

  const forged = new FormData();
  forged.set('fact_id', beforeProfile.facts[0].id);
  forged.set('file', new File([Buffer.from('not a pdf')], 'forged.pdf', { type: 'application/pdf' }));
  assert.equal((await fetch(`${baseUrl}/api/candidate-profile/evidence`, { method: 'POST', body: forged })).status, 400);
}, { timeout: 30_000 });

test('CareerPilot CN Web completes the campus workflow with structured artifacts and no restricted values', async () => {
  const source = [
    '# 匿名校招候选人',
    '## 教育经历',
    '- 本科学历',
    '- 计算机科学与技术专业',
    '- 2027届毕业生',
    '## 证书',
    '- 大学英语四级 520 分',
    '## 求职偏好',
    '- 意向工作地点为北京或上海',
    '## 技能',
    '- 掌握 Java 后端开发',
  ].join('\n');
  let response = await fetch(`${baseUrl}/api/candidate-profile/import-cv`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: source }),
  });
  await assertStatus(response);

  let profile = await (await fetch(`${baseUrl}/api/candidate-profile`)).json();
  const statements = new Map(profile.facts.map((fact) => [fact.statement, fact]));
  const requiredStatements = [
    '本科学历', '计算机科学与技术专业', '2027届毕业生',
    '大学英语四级 520 分', '意向工作地点为北京或上海', '掌握 Java 后端开发',
  ];
  for (const [index, statement] of requiredStatements.entries()) {
    const fact = statements.get(statement);
    assert.ok(fact, `missing imported Fact: ${statement}`);
    response = await fetch(`${baseUrl}/api/candidate-profile/evidence`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fact_id: fact.id,
        id: `evidence.e2e.${index}`,
        kind: 'official_link',
        ref: `https://example.invalid/e2e/${index}`,
        strength: 'strong',
      }),
    });
    await assertStatus(response);
    response = await fetch(`${baseUrl}/api/candidate-profile/fact-status`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: fact.id, status: 'confirmed' }),
    });
    await assertStatus(response);
  }

  profile = await (await fetch(`${baseUrl}/api/candidate-profile`)).json();
  const factId = (statement) => profile.facts.find((fact) => fact.statement === statement).id;
  const structured = {
    education: {
      degree: { value: 'bachelor', fact_id: factId('本科学历') },
      major_name: { value: '计算机科学与技术', fact_id: factId('计算机科学与技术专业') },
      cohort: { value: 2027, fact_id: factId('2027届毕业生') },
    },
    language_certificates: [{ kind: 'CET4', score: 520, fact_id: factId('大学英语四级 520 分') }],
    credentials: [],
    preferences: { locations: { value: ['北京', '上海'], fact_id: factId('意向工作地点为北京或上海') } },
  };
  response = await fetch(`${baseUrl}/api/cn/profile/structured`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ structured }),
  });
  await assertStatus(response);

  const jd = [
    '招聘单位：中国示例集团（中央企业）',
    '岗位名称：信息技术岗',
    '岗位代码：IT-2027-01',
    '面向2027届应届毕业生校园招聘',
    '学历要求：本科及以上',
    '专业要求：计算机科学与技术、软件工程',
    '英语要求：大学英语四级成绩达到425分',
    '工作地点：北京、上海',
    '报名截止：2027年06月30日',
  ].join('\n');
  response = await fetch(`${baseUrl}/api/cn/jobs/parse`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'text', text: jd }),
  });
  await assertStatus(response);
  let posting = await response.json();
  assert.equal(posting.employer.type, 'central_soe');
  posting.rules = posting.rules.map((rule) => ({ ...rule, confirmation_status: 'confirmed' }));
  response = await fetch(`${baseUrl}/api/cn/jobs/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ posting, official_source_confirmed: false }),
  });
  await assertStatus(response);
  posting = await response.json();
  assert.equal(posting.confirmation.status, 'confirmed');

  const dimensions = [
    { id: 'role_major', score: 4.5, candidate_fact_ids: [factId('计算机科学与技术专业')], rationale: '专业方向一致' },
    { id: 'evidence', score: 4.2, candidate_fact_ids: [], rationale: '证据完整度由已确认结构化事实支持' },
    { id: 'career_direction', score: 4, candidate_fact_ids: [], rationale: '职业方向一致' },
    { id: 'mobility', score: 4.5, candidate_fact_ids: [factId('意向工作地点为北京或上海')], rationale: '地点匹配' },
    { id: 'development', score: 4, candidate_fact_ids: [], rationale: '校招培养路径清晰' },
    { id: 'source_reliability', score: 3, candidate_fact_ids: [], rationale: '粘贴文本来源，可靠性按上限计分' },
  ];
  response = await fetch(`${baseUrl}/api/cn/jobs/evaluate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ posting, dimensions }),
  });
  await assertStatus(response);
  const evaluation = await response.json();
  assert.equal(evaluation.report.eligibility.result, 'eligible');
  assert.equal(evaluation.report.recommendation, 'apply');
  assert.match(evaluation.report.report_path, /^reports\/careerpilot\//);

  response = await fetch(`${baseUrl}/api/cn/campaigns`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '匿名 14 岗位式验收', employer: posting.employer.name, recruitment_batch: '2027 校园招聘',
      max_applications: 1, constraint_confirmation_status: 'confirmed', constraint_source_quote: '每位候选人最多投递一个岗位',
    }),
  });
  await assertStatus(response, 201);
  const campaign = (await response.json()).campaign;
  response = await fetch(`${baseUrl}/api/cn/campaigns/${campaign.id}/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sources: [{ kind: 'posting', posting }] }),
  });
  await assertStatus(response);
  response = await fetch(`${baseUrl}/api/cn/campaigns/${campaign.id}/rank`, { method: 'POST' });
  await assertStatus(response);
  response = await fetch(`${baseUrl}/api/cn/campaigns/${campaign.id}/select`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ job_id: posting.id, reason: '匿名确定性排名第一' }),
  });
  await assertStatus(response);

  response = await fetch(`${baseUrl}/api/resume-variants/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template: 'soe-one-page' }),
  });
  await assertStatus(response);
  const baseline = await confirmResumeDraft((await response.json()).variant);
  response = await fetch(`${baseUrl}/api/cn/resumes/tailor-preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ job_id: posting.id, baseline_variant_id: baseline.id, fact_ids: baseline.fact_ids, order: baseline.order }),
  });
  await assertStatus(response);
  const preview = (await response.json()).preview;
  assert.equal(preview.change_ratio, 0);
  assert.equal(preview.allowed, true);
  response = await fetch(`${baseUrl}/api/cn/resumes/tailor-export`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preview, format: 'pdf', campaign_id: campaign.id }),
  });
  await assertStatus(response);
  const formalArtifact = await response.json();
  assert.match(formalArtifact.path, /output[\\/]careerpilot/);
  assert.equal(formalArtifact.manifest.schema_version, 2);
  assert.equal(formalArtifact.manifest.qa.render_status, 'verified');

  response = await fetch(`${baseUrl}/api/cn/applications/prepare`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ job_id: posting.id, campaign_id: campaign.id, resume_manifest: `${formalArtifact.path}.manifest.json` }),
  });
  await assertStatus(response);
  const application = (await response.json()).application;
  const restricted = application.fields.filter((field) => field.sensitivity === 'restricted');
  assert.equal(restricted.length, 3);
  assert.ok(restricted.every((field) => field.manual_required && !('draft' in field) && field.source_fact_ids.length === 0));
  assert.doesNotMatch(JSON.stringify(application), /11010120000101001X/);

  const restrictedValue = '11010120000101001X';
  response = await fetch(`${baseUrl}/api/cn/applications/${application.tracker_num}/fields`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'personal.identity_number': restrictedValue }),
  });
  assert.equal(response.status, 422);
  assert.doesNotMatch(await response.text(), new RegExp(restrictedValue));
  assert.doesNotMatch(await (await fetch(`${baseUrl}/application-materials/${application.tracker_num}`)).text(), new RegExp(restrictedValue));
  assert.doesNotMatch(serverOutput, new RegExp(restrictedValue));

  response = await fetch(`${baseUrl}/api/cn/applications/${application.tracker_num}/fields`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'motivation.application': '希望在信息技术岗位持续学习并贡献已确认能力。' }),
  });
  await assertStatus(response);
  response = await fetch(`${baseUrl}/api/cn/applications/${application.tracker_num}/stage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stage: 'submitted', note: '匿名端到端测试只走到提交前' }),
  });
  assert.equal(response.status, 422);
  assert.match(await response.text(), /EXTERNAL_SUBMISSION_CONFIRMATION_REQUIRED/);
  response = await fetch(`${baseUrl}/api/cn/applications/${application.tracker_num}`);
  await assertStatus(response);
  assert.equal((await response.json()).application.current_stage, 'evaluated');

  response = await fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'evaluate', input: jd }),
  });
  assert.equal(response.status, 422, 'legacy evaluate entrypoint must not bypass explicit job confirmation');
  const blocked = await response.text();
  assert.match(blocked, /explicitly confirmed/);
  assert.doesNotMatch(blocked, /VERDICT:|"type":"artifact"/);
}, { timeout: 90_000 });
