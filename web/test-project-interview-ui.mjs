#!/usr/bin/env node

import assert from 'node:assert/strict';
import test from 'node:test';
import { PLANNED_NAV_ITEMS, PRIMARY_NAV_ITEMS } from './src/lib/nav-items.ts';

test('面试中心是正式主流程入口，不再显示为 V4 预留', () => {
  const primary = PRIMARY_NAV_ITEMS.find((item) => item.href === '/interview-center');
  assert.ok(primary);
  assert.equal(primary.label, '项目面试特训');
  assert.equal(primary.chip, undefined);
  assert.equal(PLANNED_NAV_ITEMS.some((item) => item.href === '/interview-center'), false);
});

