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

test('Web ResumeVariant preview and structured exports use the canonical Facts', async () => {
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

  response = await fetch(`${baseUrl}/api/resume-variants/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ variant: preview.variant, format: 'md' }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/markdown/);
  assert.match(await response.text(), /<!-- fact:/);

  response = await fetch(`${baseUrl}/api/resume-variants/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      variant: (await (await fetch(`${baseUrl}/api/resume-variants/preview`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ template: 'application-detail' }),
      })).json()).variant,
      format: 'docx',
    }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /wordprocessingml/);
  const docx = Buffer.from(await response.arrayBuffer());
  assert.equal(docx.subarray(0, 2).toString(), 'PK');
  assert.ok(docx.length > 5_000);

  const factId = preview.variant.fact_ids[0];
  response = await fetch(`${baseUrl}/api/candidate-profile/fact-status`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: factId, status: 'rejected' }),
  });
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/api/resume-variants/export`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ variant: preview.variant, format: 'md' }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /validation failed/i);
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
  const posting = await response.json();
  assert.equal(posting.employer.type, 'central_soe');

  const dimensions = [
    { id: 'role_major', score: 4.5, candidate_fact_ids: [factId('计算机科学与技术专业')], rationale: '专业方向一致' },
    { id: 'evidence', score: 4.2, candidate_fact_ids: [factId('掌握 Java 后端开发')], rationale: '已有技能事实' },
    { id: 'career_direction', score: 4, candidate_fact_ids: [], rationale: '职业方向一致' },
    { id: 'mobility', score: 4.5, candidate_fact_ids: [factId('意向工作地点为北京或上海')], rationale: '地点匹配' },
    { id: 'development', score: 4, candidate_fact_ids: [], rationale: '校招培养路径清晰' },
    { id: 'source_reliability', score: 5, candidate_fact_ids: [], rationale: '待官网复核' },
  ];
  response = await fetch(`${baseUrl}/api/cn/jobs/evaluate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ posting, dimensions }),
  });
  await assertStatus(response);
  const evaluation = await response.json();
  assert.equal(evaluation.report.eligibility.result, 'eligible');
  assert.equal(evaluation.report.recommendation, 'apply');
  assert.match(evaluation.report.report_path, /^reports\/careerpilot\//);

  response = await fetch(`${baseUrl}/api/cn/resumes/baselines`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template: 'soe-one-page' }),
  });
  await assertStatus(response);
  const baseline = (await response.json()).variant;
  response = await fetch(`${baseUrl}/api/cn/resumes/tailor-preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ job_id: posting.id, baseline_variant_id: baseline.id, fact_ids: baseline.fact_ids, order: baseline.order }),
  });
  await assertStatus(response);
  const preview = (await response.json()).preview;
  assert.equal(preview.change_ratio, 0);
  assert.equal(preview.allowed, true);
  response = await fetch(`${baseUrl}/api/cn/resumes/tailor-export`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ preview, format: 'md' }),
  });
  await assertStatus(response);
  assert.match((await response.json()).path, /output[\\/]careerpilot/);

  response = await fetch(`${baseUrl}/api/cn/applications/prepare`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ job_id: posting.id }),
  });
  await assertStatus(response);
  const application = (await response.json()).application;
  const restricted = application.fields.filter((field) => field.sensitivity === 'restricted');
  assert.equal(restricted.length, 3);
  assert.ok(restricted.every((field) => field.manual_required && !('draft' in field) && field.source_fact_ids.length === 0));
  assert.doesNotMatch(JSON.stringify(application), /11010120000101001X/);

  response = await fetch(`${baseUrl}/api/cn/applications/${application.tracker_num}/fields`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'motivation.application': '希望在信息技术岗位持续学习并贡献已确认能力。' }),
  });
  await assertStatus(response);
  response = await fetch(`${baseUrl}/api/cn/applications/${application.tracker_num}/stage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stage: 'submitted', note: '匿名端到端测试' }),
  });
  await assertStatus(response);
  const stage = await response.json();
  assert.equal(stage.application.canonical_status, 'Applied');
  assert.equal(stage.reconciliation.consistent, true);

  response = await fetch(`${baseUrl}/api/run`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'evaluate', input: jd }),
  });
  await assertStatus(response);
  const stream = await response.text();
  assert.doesNotMatch(stream, /VERDICT:/);
  const artifactEvent = stream.trim().split('\n').map((line) => JSON.parse(line)).find((event) => event.type === 'artifact');
  assert.equal(artifactEvent.artifact.job_id, posting.id);
  assert.equal(artifactEvent.artifact.eligibility, 'eligible');
  assert.equal(typeof artifactEvent.artifact.score, 'number');
}, { timeout: 90_000 });
