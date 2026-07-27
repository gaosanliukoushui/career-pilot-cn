#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import JSZip from 'jszip';
import { createResumeVariant, exportResume } from './lib/careerpilot/resume-core.mjs';
import { randomUUID } from 'node:crypto';

const repoRoot = import.meta.dirname;
const qaRoot = resolve(repoRoot, 'output', 'careerpilot', 'qa-anonymous-workspace');
const runId = randomUUID().slice(0, 8);
mkdirSync(join(qaRoot, 'profile'), { recursive: true });
const profile = yaml.load(readFileSync(join(repoRoot, 'examples', 'cn-profile', 'candidate.yml'), 'utf8'));
profile.facts.push({
  id: 'campus.anonymous.coordination',
  type: 'campus',
  statement: '负责匿名校园活动的协调、信息汇总与材料整理',
  status: 'confirmed',
  sensitivity: 'personal',
  allowed_uses: ['resume', 'application_form'],
  evidence_ids: ['evidence.campus.confirmation'],
  source: 'careerpilot-export-qa',
});
profile.evidence.push({
  id: 'evidence.campus.confirmation',
  kind: 'user_confirmation',
  ref: 'confirmation:anonymous-qa',
  strength: 'ordinary',
  verified_at: '2026-07-27T12:00:00.000Z',
});
writeFileSync(join(qaRoot, 'profile', 'candidate.yml'), yaml.dump(profile, { noRefs: true, lineWidth: 120 }), 'utf8');

const results = [];
for (const template of ['soe-one-page', 'tech-two-page', 'application-detail']) {
  const variant = createResumeVariant(qaRoot, { template, status: 'ready' });
  for (const format of ['md', 'docx', 'pdf']) {
    const relativePath = `output/careerpilot/runs/${runId}/${template}.${format}`;
    const result = await exportResume(qaRoot, variant, format, relativePath);
    results.push({ template, format, path: result.path, fact_ids: result.manifest.fact_ids });
  }
}

for (const result of results.filter((item) => item.format === 'docx')) {
  const archive = await JSZip.loadAsync(readFileSync(result.path));
  const xml = await archive.file('word/document.xml')?.async('string');
  if (!xml || !result.fact_ids.every((id) => xml.includes(`fact:${id}`))) {
    throw new Error(`DOCX traceability check failed: ${result.path}`);
  }
}

const reportPath = join(qaRoot, 'output', 'careerpilot', 'qa-results.json');
writeFileSync(reportPath, `${JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ qa_root: qaRoot, report: reportPath, exports: results.length }, null, 2));
