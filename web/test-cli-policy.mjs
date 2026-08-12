#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KNOWN, findBin, minimalCliEnv, proposalArgs, proposalCapable, proposalCliEnv } from './src/lib/clis.ts';
import { runJsonProposal } from './src/lib/ai-proposal.ts';
import { AiProposalError, aiProcessFailureMessage, parseJsonProposalOutput, proposalAbortError, proposalTerminationPlan } from './src/lib/ai-proposal-core.mjs';
import { buildProjectInterviewRetryPrompt, shouldRetryProjectInterviewProposal, shouldUseProjectInterviewFallback } from './src/lib/project-interview-api.ts';

test('Web AI 只启用具备应用级无工具或只读策略的 CLI', () => {
  assert.equal(proposalCapable('claude'), true);
  assert.equal(proposalCapable('codex'), false, 'Codex exec 尚无可强制的 no-tools 模式');
  for (const id of ['codex', 'gemini', 'opencode', 'copilot', 'qwen', 'antigravity']) {
    assert.equal(proposalCapable(id), false, `${id} must stay disabled until an enforceable policy exists`);
  }
  assert.equal(KNOWN.every((item) => typeof item.proposalPolicy === 'string'), true);
});

test('Claude 强制无工具；Codex 仅保留只读参数但不开放 Web 提案', () => {
  assert.throws(() => proposalArgs('claude'), /MCP/);
  const claude = proposalArgs('claude', { mcpConfigPath: 'C:\\Temp\\empty-mcp.json' });
  assert.match(claude.join(' '), /--disallowedTools/);
  assert.deepEqual(claude.slice(claude.indexOf('--tools'), claude.indexOf('--tools') + 2), ['--tools', '']);
  assert.ok(claude.includes('--disable-slash-commands'));
  assert.ok(claude.includes('--no-chrome'));
  assert.ok(claude.includes('--strict-mcp-config'));
  assert.deepEqual(claude.slice(claude.indexOf('--mcp-config'), claude.indexOf('--mcp-config') + 2), [
    '--mcp-config', 'C:\\Temp\\empty-mcp.json',
  ]);
  assert.deepEqual(
    claude.slice(claude.indexOf('--setting-sources'), claude.indexOf('--setting-sources') + 2),
    ['--setting-sources', 'local'],
    'Claude 2.1.x 会吞掉空值并把后一个选项误当 setting source；隔离 cwd 下只加载 local 才能兼顾 OAuth 与配置隔离',
  );
  const systemPromptIndex = claude.indexOf('--system-prompt');
  assert.notEqual(systemPromptIndex, -1, 'Claude 必须替换默认编码代理提示词');
  assert.match(claude[systemPromptIndex + 1], /JSON transformation worker/);
  assert.match(claude[systemPromptIndex + 1], /Do not inspect/);
  assert.deepEqual(claude.slice(claude.indexOf('--effort'), claude.indexOf('--effort') + 2), ['--effort', 'low']);
  assert.deepEqual(
    claude.slice(claude.indexOf('--model'), claude.indexOf('--model') + 2),
    ['--model', 'haiku'],
    '项目面试结构化规划应显式使用快速模型别名，不能继承用户级超长上下文默认模型',
  );
  assert.equal(claude.includes('prompt'), false, '模型提示词必须走 stdin，不能进入 Windows shell 命令行');
  const codex = proposalArgs('codex');
  assert.deepEqual(codex.slice(0, 2), ['exec', '-']);
  assert.ok(codex.includes('read-only'));
  assert.ok(codex.includes('--ephemeral'));
  assert.ok(codex.includes('--ignore-user-config'));
  assert.deepEqual(proposalArgs('claude', {
    schemaJson: '{"type":"object"}',
    mcpConfigPath: 'C:\\Temp\\empty-mcp.json',
  }).slice(-2), [
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

test('Claude 只从用户设置提取模型认证白名单，不加载 hooks 或无关云凭据', () => {
  const directory = mkdtempSync(join(tmpdir(), 'careerpilot-claude-settings-'));
  const settingsPath = join(directory, 'settings.json');
  try {
    writeFileSync(settingsPath, JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'dummy-auth-token',
        ANTHROPIC_BASE_URL: 'https://model-gateway.example.test',
        ANTHROPIC_MODEL: 'model-alias',
        AWS_SECRET_ACCESS_KEY: 'must-not-pass',
      },
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'must-not-run' }] }] },
    }), 'utf8');
    const env = proposalCliEnv('claude', { PATH: 'test-path', USERPROFILE: directory }, settingsPath);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'dummy-auth-token');
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://model-gateway.example.test');
    assert.equal(env.ANTHROPIC_MODEL, 'model-alias');
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(JSON.stringify(env).includes('must-not-run'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

test('浏览器取消请求时返回可识别的 AI 取消错误', () => {
  const error = proposalAbortError('项目面试回答点评');
  assert.ok(error instanceof AiProposalError);
  assert.equal(error.code, 'AI_ABORTED');
  assert.equal(error.status, 499);
  assert.match(error.message, /已取消/);
});

test('调用前已经取消的请求不会启动 AI CLI 或写入提示词', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'careerpilot-pre-abort-'));
  const marker = join(directory, 'spawned.txt');
  const originalPath = process.env.PATH;
  try {
    writeFileSync(join(directory, 'claude.cmd'), `@echo spawned>"${marker}"\r\n`, 'utf8');
    process.env.PATH = `${directory};${originalPath || ''}`;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => runJsonProposal('claude', '不得发送的简历 Fact', { signal: controller.signal }),
      (error) => error instanceof AiProposalError && error.code === 'AI_ABORTED',
    );
    assert.equal(existsSync(marker), false);
  } finally {
    process.env.PATH = originalPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('项目面试只对模型结构或事实计划漂移做一次受限重试', () => {
  assert.equal(shouldRetryProjectInterviewProposal('INTERVIEW_REVIEW_INVALID', 0), true);
  assert.equal(shouldRetryProjectInterviewProposal('INTERVIEW_PACK_INVALID', 0), true);
  assert.equal(shouldRetryProjectInterviewProposal('INTERVIEW_REVIEW_INVALID', 1), false);
  assert.equal(shouldRetryProjectInterviewProposal('INTERVIEW_PROJECT_NOT_FOUND', 0), false);
  const prompt = buildProjectInterviewRetryPrompt('trusted prompt', [
    { code: 'schema_invalid', path: '/sharpen', message: 'ignored secret-looking detail' },
    { code: 'fact_hash_mismatch', path: '/stronger_fact_refs/0', fact_id: 'project.safe.fact', expected: 'do-not-echo' },
  ]);
  assert.match(prompt, /trusted prompt/);
  assert.match(prompt, /schema_invalid/);
  assert.match(prompt, /project\.safe\.fact/);
  assert.doesNotMatch(prompt, /ignored secret-looking detail|do-not-echo/);
  assert.match(prompt, /完整 JSON/);
  assert.equal(shouldUseProjectInterviewFallback('INTERVIEW_PACK_INVALID', 1), true);
  assert.equal(shouldUseProjectInterviewFallback('INTERVIEW_REVIEW_INVALID', 1), true);
  assert.equal(shouldUseProjectInterviewFallback('INTERVIEW_PACK_INVALID', 0), false);
  assert.equal(shouldUseProjectInterviewFallback('AI_TIMEOUT', 1), false);
});
