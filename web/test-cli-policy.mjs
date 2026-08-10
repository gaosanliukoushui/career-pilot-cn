#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KNOWN, findBin, minimalCliEnv, proposalArgs, proposalCapable } from './src/lib/clis.ts';
import { aiProcessFailureMessage, parseJsonProposalOutput, proposalTerminationPlan } from './src/lib/ai-proposal-core.mjs';

test('Web AI 只启用具备应用级无工具或只读策略的 CLI', () => {
  assert.equal(proposalCapable('claude'), true);
  assert.equal(proposalCapable('codex'), true);
  for (const id of ['gemini', 'opencode', 'copilot', 'qwen', 'antigravity']) {
    assert.equal(proposalCapable(id), false, `${id} must stay disabled until an enforceable policy exists`);
  }
  assert.equal(KNOWN.every((item) => typeof item.proposalPolicy === 'string'), true);
});

test('Claude 禁用工具，Codex 使用只读临时会话', () => {
  const claude = proposalArgs('claude');
  assert.match(claude.join(' '), /--disallowedTools/);
  const systemPromptIndex = claude.indexOf('--system-prompt');
  assert.notEqual(systemPromptIndex, -1, 'Claude 必须替换默认编码代理提示词');
  assert.match(claude[systemPromptIndex + 1], /JSON transformation worker/);
  assert.match(claude[systemPromptIndex + 1], /Do not inspect/);
  assert.deepEqual(claude.slice(claude.indexOf('--effort'), claude.indexOf('--effort') + 2), ['--effort', 'low']);
  assert.equal(claude.includes('prompt'), false, '模型提示词必须走 stdin，不能进入 Windows shell 命令行');
  const codex = proposalArgs('codex');
  assert.deepEqual(codex.slice(0, 2), ['exec', '-']);
  assert.ok(codex.includes('read-only'));
  assert.ok(codex.includes('--ephemeral'));
  assert.ok(codex.includes('--ignore-user-config'));
  assert.deepEqual(proposalArgs('claude', { schemaJson: '{"type":"object"}' }).slice(-2), [
    '--json-schema', '{"type":"object"}',
  ]);
  assert.deepEqual(proposalArgs('codex', { schemaPath: 'C:\\Temp\\schema.json' }).slice(-2), [
    '--output-schema', 'C:\\Temp\\schema.json',
  ]);
});

test('Windows 优先选择可启动的扩展名 shim，不把无扩展名 npm shell 脚本交给 spawn', {
  skip: process.platform !== 'win32',
}, () => {
  const directory = mkdtempSync(join(tmpdir(), 'careerpilot-cli-'));
  try {
    writeFileSync(join(directory, 'mockcli'), '#!/bin/sh\n');
    writeFileSync(join(directory, 'mockcli.cmd'), '@echo off\r\n');
    assert.equal(findBin('mockcli', [directory])?.toLowerCase(), join(directory, 'mockcli.cmd').toLowerCase());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test('结构化 AI 输出只接受 JSON 对象，并兼容 CLI 外层 result 与代码围栏', () => {
  assert.deepEqual(parseJsonProposalOutput('{"answer":"ok"}'), { answer: 'ok' });
  assert.deepEqual(parseJsonProposalOutput('{"result":"```json\\n{\\"answer\\":\\"ok\\"}\\n```"}'), { answer: 'ok' });
  assert.deepEqual(parseJsonProposalOutput('{"result":"ignored","structured_output":{"answer":"ok"}}'), { answer: 'ok' });
  assert.deepEqual(parseJsonProposalOutput('progress {"type":"started"}\n{"type":"result","structured_output":{"answer":"ok"}}'), { answer: 'ok' });
  assert.throws(() => parseJsonProposalOutput('[1,2,3]'), /JSON 对象/);
  assert.throws(() => parseJsonProposalOutput('没有结构化输出'), /JSON 对象/);
});

test('AI CLI 失败信息不会回显可能包含简历事实的 stderr', () => {
  const stderr = 'user prompt: project.secret.summary';
  const message = aiProcessFailureMessage('项目面试训练包生成');
  assert.doesNotMatch(message, new RegExp(stderr));
  assert.doesNotMatch(message, /project\.secret/);
  assert.match(message, /检查 CLI 登录状态或切换模型/);
});

test('Windows 超时会结束 AI CLI 的整个进程树', () => {
  assert.deepEqual(proposalTerminationPlan('win32', 321), {
    command: 'taskkill.exe', args: ['/pid', '321', '/t', '/f'],
  });
  assert.equal(proposalTerminationPlan('linux', 321), null);
  assert.equal(proposalTerminationPlan('win32', undefined), null);
});
