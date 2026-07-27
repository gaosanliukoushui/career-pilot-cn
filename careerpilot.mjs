#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
async function readStdin() {
  let content = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) content += chunk;
  return content;
}

function option(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function positional(args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith('--')) {
      index += 1;
      continue;
    }
    values.push(args[index]);
  }
  return values;
}

function required(value, label) {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function usage() {
  return {
    usage: [
      'node careerpilot.mjs validate [--root PATH]',
      'node careerpilot.mjs show [--root PATH]',
      'node careerpilot.mjs import-cv [CV_PATH] [--root PATH]',
      'node careerpilot.mjs import-cv --stdin [--root PATH]',
      'node careerpilot.mjs confirm|reject FACT_ID [--root PATH]',
      'node careerpilot.mjs set-status FACT_ID unconfirmed|confirmed|rejected|conflicted [--root PATH]',
      'node careerpilot.mjs attach-evidence FACT_ID --id ID --kind KIND --ref REF --strength ordinary|strong [--verified-at ISO] [--root PATH]',
      'node careerpilot.mjs project-cv [--root PATH]',
      'node careerpilot.mjs preview-cv [--root PATH]',
      'node careerpilot.mjs audit [--root PATH]',
    ],
  };
}

async function main() {
  const {
    attachEvidence,
    auditCandidateProfile,
    auditProjectedCv,
    importCvMarkdown,
    loadCandidateProfile,
    previewCv,
    projectCv,
    updateFactStatus,
    validateCandidateProfile,
  } = await import('./lib/careerpilot/profile-core.mjs');
  const args = process.argv.slice(2);
  const command = args.shift();
  const root = resolve(option(args, '--root', process.cwd()));
  const positionals = positional(args);

  switch (command) {
    case 'validate': {
      const result = validateCandidateProfile(loadCandidateProfile(root));
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.valid) process.exitCode = 1;
      return;
    }
    case 'show':
      process.stdout.write(`${JSON.stringify(loadCandidateProfile(root))}\n`);
      return;
    case 'import-cv': {
      let markdown;
      if (args.includes('--stdin')) {
        markdown = await readStdin();
      } else {
        const cvPath = resolve(root, positionals[0] || 'cv.md');
        if (!existsSync(cvPath)) throw new Error(`CV file not found: ${cvPath}`);
        markdown = readFileSync(cvPath, 'utf8');
      }
      process.stdout.write(`${JSON.stringify(importCvMarkdown(root, markdown))}\n`);
      return;
    }
    case 'confirm':
    case 'reject': {
      const fact = updateFactStatus(root, required(positionals[0], 'FACT_ID'), command === 'confirm' ? 'confirmed' : 'rejected');
      process.stdout.write(`${JSON.stringify(fact)}\n`);
      return;
    }
    case 'set-status': {
      const fact = updateFactStatus(root, required(positionals[0], 'FACT_ID'), required(positionals[1], 'STATUS'));
      process.stdout.write(`${JSON.stringify(fact)}\n`);
      return;
    }
    case 'attach-evidence': {
      const evidence = {
        id: required(option(args, '--id'), '--id'),
        kind: required(option(args, '--kind'), '--kind'),
        ref: required(option(args, '--ref'), '--ref'),
        strength: required(option(args, '--strength'), '--strength'),
        verified_at: option(args, '--verified-at', new Date().toISOString()),
      };
      const result = attachEvidence(root, required(positionals[0], 'FACT_ID'), evidence);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    case 'project-cv': {
      const result = projectCv(root);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    case 'preview-cv':
      process.stdout.write(`${JSON.stringify(previewCv(root))}\n`);
      return;
    case 'audit': {
      const result = {
        profile: auditCandidateProfile(root),
        projection: auditProjectedCv(root),
      };
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.profile.valid || !result.projection.valid) process.exitCode = 1;
      return;
    }
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(`${JSON.stringify(usage(), null, 2)}\n`);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error.message, code: error.code, details: error.details })}\n`);
  process.exitCode = 1;
});
