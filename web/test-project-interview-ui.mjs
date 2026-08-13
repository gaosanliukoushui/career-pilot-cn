#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PLANNED_NAV_ITEMS, PRIMARY_NAV_ITEMS } from './src/lib/nav-items.ts';

test('面试中心是正式主流程入口，不再显示为 V4 预留', () => {
  const primary = PRIMARY_NAV_ITEMS.find((item) => item.href === '/interview-center');
  assert.ok(primary);
  assert.equal(primary.label, '项目面试特训');
  assert.equal(primary.chip, undefined);
  assert.equal(PLANNED_NAV_ITEMS.some((item) => item.href === '/interview-center'), false);
});

test('更换岗位或 AI 时清空旧训练结果，项目面试只使用 Codex', () => {
  const source = readFileSync(join(import.meta.dirname, 'src', 'components', 'cn', 'project-interview-workbench.tsx'), 'utf8');
  assert.match(source, /function chooseTargetRole[\s\S]*resetTraining\(\)/);
  assert.match(source, /function chooseCli[\s\S]*resetTraining\(\)/);
  assert.match(source, /async function generatePack[\s\S]*resetTraining\(\)/);
  assert.match(source, /function cancelInFlight[\s\S]*\.abort\(\)/);
  assert.match(source, /packRequest\.current\.id !== requestId/);
  assert.match(source, /reviewRequest\.current\.id !== requestId/);
  assert.match(source, /表达观察（事实另核）/);
  assert.match(source, /先登录并安装 Codex/);
  assert.match(source, /item\.id === "codex"/);
  assert.match(source, /item\.projectInterviewAvailable/);
  assert.doesNotMatch(source, /支持强制无工具模式的 Claude Code/);
  const packRoute = readFileSync(join(import.meta.dirname, 'src', 'app', 'api', 'cn', 'interviews', 'projects', 'pack', 'route.ts'), 'utf8');
  const reviewRoute = readFileSync(join(import.meta.dirname, 'src', 'app', 'api', 'cn', 'interviews', 'projects', 'review', 'route.ts'), 'utf8');
  const proposalRunner = readFileSync(join(import.meta.dirname, 'src', 'lib', 'ai-proposal.ts'), 'utf8');
  assert.match(packRoute, /signal: request\.signal/);
  assert.match(reviewRoute, /signal: request\.signal/);
  assert.match(reviewRoute, /buildProjectInterviewRetryPrompt/);
  assert.match(packRoute, /timeoutMs: 120_000/);
  assert.match(reviewRoute, /timeoutMs: 120_000/);
  assert.match(packRoute, /interview-pack-fallback/);
  assert.match(reviewRoute, /interview-review-fallback/);
  assert.match(packRoute, /X-CareerPilot-Generation-Mode/);
  assert.match(source, /response\.headers\.get\("X-CareerPilot-Generation-Mode"\)/);
  assert.match(source, /确定性安全降级/);
  assert.match(source, /0 分仅表示未评分/);
  assert.ok(
    proposalRunner.indexOf('if (options.signal?.aborted) throw proposalAbortError(label)')
      < proposalRunner.indexOf('resolveProposalCli(cliId)'),
    '预取消必须在解析或启动 CLI 前返回',
  );
  assert.match(proposalRunner, /if \(!pendingFailure && !options\.signal\?\.aborted\) child\.stdin\.end\(prompt\)/);
});

test('面试中心使用中文且不硬编码项目数量', () => {
  const source = readFileSync(join(import.meta.dirname, 'src', 'app', 'interview-center', 'page.tsx'), 'utf8');
  assert.match(source, /AI 项目面试特训/);
  assert.match(source, /正式简历实际选中的项目/);
  assert.doesNotMatch(source, /AI Project Interview Lab|三个项目/);
});
