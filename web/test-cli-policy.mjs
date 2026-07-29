#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN, minimalCliEnv, proposalArgs, proposalCapable } from './src/lib/clis.ts';

test('Web AI 只启用具备应用级无工具或只读策略的 CLI', () => {
  assert.equal(proposalCapable('claude'), true);
  assert.equal(proposalCapable('codex'), true);
  for (const id of ['gemini', 'opencode', 'copilot', 'qwen', 'antigravity']) {
    assert.equal(proposalCapable(id), false, `${id} must stay disabled until an enforceable policy exists`);
  }
  assert.equal(KNOWN.every((item) => typeof item.proposalPolicy === 'string'), true);
});

test('Claude 禁用工具，Codex 使用只读临时会话', () => {
  assert.match(proposalArgs('claude', 'prompt').join(' '), /--disallowedTools/);
  const codex = proposalArgs('codex', 'prompt');
  assert.deepEqual(codex.slice(0, 2), ['exec', 'prompt']);
  assert.ok(codex.includes('read-only'));
  assert.ok(codex.includes('--ephemeral'));
  assert.ok(codex.includes('--ignore-user-config'));
});

test('AI 子进程不继承无关凭据', () => {
  const env = minimalCliEnv('codex', {
    PATH: 'bin', SystemRoot: 'C:\\Windows', TEMP: 'tmp', USERPROFILE: 'user',
    OPENAI_API_KEY: 'allowed', AWS_SECRET_ACCESS_KEY: 'blocked', GITHUB_TOKEN: 'blocked',
  });
  assert.equal(env.OPENAI_API_KEY, 'allowed');
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.PATH, 'bin');
});
