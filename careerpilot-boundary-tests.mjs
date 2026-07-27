import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

test('CareerPilot CN identifies the fork without removing upstream attribution', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'career-pilot-cn');
  assert.equal(pkg.repository.url, 'https://github.com/gaosanliukoushui/career-pilot-cn');
  const readme = read('README.cn.md');
  assert.match(readme, /CareerPilot CN 二次开发/);
  assert.match(readme, /MIT.*career-ops/s);
  assert.match(read('LICENSE'), /Santiago Fernández de Valderrama/);
});

test('automatic upstream application is blocked while update checks remain available', () => {
  const result = spawnSync(process.execPath, ['update-system.mjs', 'apply'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /disables automatic upstream application/);
  assert.equal(JSON.parse(read('package.json')).scripts.update, 'node update-system.mjs check');
});

test('candidate profile data is an ignored user-layer path', () => {
  assert.match(read('.gitignore'), /^profile\/$/m);
  assert.match(read('DATA_CONTRACT.md'), /`profile\/\*`.*Candidate Facts.*Evidence/i);
  assert.match(read('.gitignore'), /^!package-lock\.json$/m);
});

test('Claude remains a thin wrapper over canonical agent instructions', () => {
  const claude = read('CLAUDE.md').trim();
  assert.match(claude, /^@AGENTS\.md/);
  assert.doesNotMatch(claude, /## Agent skills/);
  assert.match(read('AGENTS.md'), /## Agent skills/);
});
