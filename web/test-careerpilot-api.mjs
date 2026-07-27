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

before(async () => {
  const canonicalCli = pathToFileURL(join(repoRoot, 'careerpilot.mjs')).href;
  writeFileSync(join(dataRoot, 'careerpilot.mjs'), `import ${JSON.stringify(canonicalCli)};\n`, 'utf8');
  writeFileSync(join(dataRoot, 'cv.md'), '# 旧版匿名简历\n\n- 尚未迁移的内容\n', 'utf8');
  server = spawn(process.execPath, [join(webRoot, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: webRoot,
    env: { ...process.env, CAREER_OPS_ROOT: dataRoot, NEXT_TELEMETRY_DISABLED: '1' },
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
