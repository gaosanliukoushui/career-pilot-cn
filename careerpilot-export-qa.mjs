#!/usr/bin/env node

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import JSZip from 'jszip';
import { confirmResumeVariant, createResumeVariant, exportResume } from './lib/careerpilot/resume-core.mjs';
import { getResumeStyleCatalog, saveResumeStyle } from './lib/careerpilot/resume-style-core.mjs';

const repoRoot = import.meta.dirname;
const persistentRoot = process.env.CAREERPILOT_QA_OUTPUT ? resolve(process.env.CAREERPILOT_QA_OUTPUT) : null;
if (persistentRoot && existsSync(persistentRoot)) throw new Error(`CAREERPILOT_QA_OUTPUT already exists: ${persistentRoot}`);
const qaRoot = persistentRoot || mkdtempSync(join(tmpdir(), 'cp-export-qa-'));
if (persistentRoot) mkdirSync(qaRoot, { recursive: true });

try {
  mkdirSync(join(qaRoot, 'profile'), { recursive: true });
  const profile = yaml.load(readFileSync(join(repoRoot, 'examples', 'cn-profile', 'resume-style-preview.yml'), 'utf8'));
  writeFileSync(join(qaRoot, 'profile', 'candidate.yml'), yaml.dump(profile, { noRefs: true, lineWidth: 120 }), 'utf8');

  const results = [];
  const catalog = getResumeStyleCatalog(qaRoot);
  for (const definition of catalog.styles) {
    const style = { ...structuredClone(definition.defaults), schema_version: 2, theme: definition.id };
    saveResumeStyle(qaRoot, style);
    const template = style.page_budget === 1 ? 'soe-one-page' : 'tech-two-page';
    const variant = confirmResumeVariant(qaRoot, createResumeVariant(qaRoot, { template })).variant;
    for (const format of ['md', 'docx', 'pdf']) {
      const relativePath = `output/careerpilot/style-previews/${definition.id}.${format}`;
      const result = await exportResume(qaRoot, variant, format, relativePath);
      if (format === 'docx') {
        const archive = await JSZip.loadAsync(readFileSync(result.path));
        const xml = await archive.file('word/document.xml')?.async('string');
        if (!xml || !result.manifest.fact_ids.every((id) => xml.includes(`fact:${id}`))) throw new Error(`DOCX traceability check failed: ${definition.id}`);
      }
      if (['docx', 'pdf'].includes(format) && (result.manifest.qa?.render_status !== 'verified' || result.manifest.qa.page_count > style.page_budget)) {
        throw new Error(`Render QA manifest check failed: ${definition.id}.${format}`);
      }
      results.push({ style: definition.id, template, page_budget: style.page_budget, format, path: result.path, bytes: readFileSync(result.path).length, fact_count: result.manifest.fact_ids.length });
    }
  }
  const report = { status: 'pass', anonymous: true, short_path: qaRoot, persistent: Boolean(persistentRoot), exports: results };
  if (persistentRoot) writeFileSync(join(qaRoot, 'qa-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (!persistentRoot) rmSync(qaRoot, { recursive: true, force: true });
}
