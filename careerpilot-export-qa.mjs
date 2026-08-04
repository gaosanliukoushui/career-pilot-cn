#!/usr/bin/env node

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import JSZip from 'jszip';
import { confirmResumeVariant, createResumeVariant, exportResume } from './lib/careerpilot/resume-core.mjs';
import { verifyRenderedResumeDocx, verifyRenderedResumePdf } from './lib/careerpilot/artifact-qa-core.mjs';

const repoRoot = import.meta.dirname;
const qaRoot = mkdtempSync(join(tmpdir(), 'cp-export-qa-'));
const pageBudgets = { 'soe-one-page': 1, 'tech-two-page': 2, 'application-detail': 2 };

try {
  mkdirSync(join(qaRoot, 'profile'), { recursive: true });
  const profile = yaml.load(readFileSync(join(repoRoot, 'examples', 'cn-profile', 'candidate.yml'), 'utf8'));
  profile.facts.push({
    id: 'campus.anonymous.coordination', type: 'campus',
    statement: '负责匿名校园活动的协调、信息汇总与材料整理', status: 'confirmed', sensitivity: 'personal',
    allowed_uses: ['resume', 'application_form'], evidence_ids: ['evidence.campus.confirmation'], source: 'careerpilot-export-qa',
  });
  profile.evidence.push({
    id: 'evidence.campus.confirmation', kind: 'user_confirmation', ref: 'confirmation:anonymous-qa',
    strength: 'ordinary', verified_at: '2026-07-27T12:00:00.000Z',
  });
  writeFileSync(join(qaRoot, 'profile', 'candidate.yml'), yaml.dump(profile, { noRefs: true, lineWidth: 120 }), 'utf8');

  const results = [];
  for (const template of Object.keys(pageBudgets)) {
    const variant = confirmResumeVariant(qaRoot, createResumeVariant(qaRoot, { template })).variant;
    const expectedStatements = variant.order.map((id) => profile.facts.find((fact) => fact.id === id)?.statement).filter(Boolean);
    for (const format of ['md', 'docx', 'pdf']) {
      const relativePath = `output/careerpilot/runs/${template}.${format}`;
      const result = await exportResume(qaRoot, variant, format, relativePath);
      if (format === 'docx') {
        const archive = await JSZip.loadAsync(readFileSync(result.path));
        const xml = await archive.file('word/document.xml')?.async('string');
        if (!xml || !result.manifest.fact_ids.every((id) => xml.includes(`fact:${id}`))) throw new Error(`DOCX traceability check failed: ${template}`);
        await verifyRenderedResumeDocx(result.path, { pageBudget: pageBudgets[template], expectedStatements });
      }
      if (format === 'pdf') await verifyRenderedResumePdf(result.path, { pageBudget: pageBudgets[template], expectedStatements });
      results.push({ template, format, bytes: readFileSync(result.path).length, fact_count: result.manifest.fact_ids.length });
    }
  }
  console.log(JSON.stringify({ status: 'pass', anonymous: true, short_path: qaRoot, exports: results }, null, 2));
} finally {
  rmSync(qaRoot, { recursive: true, force: true });
}
