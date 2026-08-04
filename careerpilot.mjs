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
      'node careerpilot.mjs migrate-profile [--root PATH]',
      'node careerpilot.mjs confirm|reject FACT_ID [--root PATH]',
      'node careerpilot.mjs set-status FACT_ID unconfirmed|confirmed|rejected|conflicted [--root PATH]',
      'node careerpilot.mjs attach-evidence FACT_ID --id ID --kind KIND --ref REF --strength ordinary|strong [--verified-at ISO] [--root PATH]',
      'node careerpilot.mjs project-cv [--root PATH]',
      'node careerpilot.mjs preview-cv [--root PATH]',
      'node careerpilot.mjs audit [--root PATH]',
      'node careerpilot.mjs resume-preview [--stdin | --template soe-one-page|tech-two-page|application-detail] [--root PATH]',
      'node careerpilot.mjs resume-save --template TEMPLATE [--root PATH]',
      'node careerpilot.mjs resume-confirm --stdin [--root PATH]',
      'node careerpilot.mjs resume-export --variant-stdin --format md|html|docx|pdf [--output output/careerpilot/FILE] [--root PATH]',
      'node careerpilot.mjs job-parse --stdin | --file PATH [--allowed-root PATH] | --url URL [--root PATH]',
      'node careerpilot.mjs job-confirm --stdin [--root PATH]',
      'node careerpilot.mjs job-evaluate --stdin [--no-persist] [--root PATH]',
      'node careerpilot.mjs job-proposal-validate --stdin [--root PATH]',
      'node careerpilot.mjs job-show JOB_ID [--root PATH]',
      'node careerpilot.mjs campaign-create --stdin [--root PATH]',
      'node careerpilot.mjs campaign-import --campaign ID --stdin [--allowed-root PATH] [--root PATH]',
      'node careerpilot.mjs campaign-rank --campaign ID [--root PATH]',
      'node careerpilot.mjs campaign-select --campaign ID --job JOB_ID[,JOB_ID] --stdin [--root PATH]',
      'node careerpilot.mjs campaign-exclude --campaign ID --job JOB_ID --stdin [--root PATH]',
      'node careerpilot.mjs campaign-show ID [--root PATH]',
      'node careerpilot.mjs campaign-list [--root PATH]',
      'node careerpilot.mjs campaign-constraints --campaign ID --stdin [--root PATH]',
      'node careerpilot.mjs capabilities --json [--stdin] [--root PATH]',
      'node careerpilot.mjs cleanup --dry-run|--apply --older-than DAYS [--root PATH]',
      'node careerpilot.mjs resume-tailor-preview --job JOB_ID --baseline VARIANT_ID [--stdin] [--save] [--root PATH]',
      'node careerpilot.mjs resume-tailor-suggest --job JOB_ID --baseline VARIANT_ID [--root PATH]',
      'node careerpilot.mjs resume-tailor-export --stdin --format md|html|docx|pdf [--campaign ID] [--output output/careerpilot/FILE] [--root PATH]',
      'node careerpilot.mjs application-prepare --job JOB_ID [--root PATH]',
      'node careerpilot.mjs application-stage TRACKER_NUM STAGE [--note TEXT] [--external-submission-confirmed] [--root PATH]',
      'node careerpilot.mjs application-show TRACKER_NUM [--root PATH]',
      'node careerpilot.mjs application-fields TRACKER_NUM --stdin [--root PATH]',
      'node careerpilot.mjs application-list [--root PATH]',
      'node careerpilot.mjs job-context [--root PATH]',
      'node careerpilot.mjs profile-structure --stdin [--root PATH]',
      'node careerpilot.mjs resume-list [--approved] [--root PATH]',
      'node careerpilot.mjs resume-variant-show VARIANT_ID [--root PATH]',
      'node careerpilot.mjs resume-workspace [--root PATH]',
      'node careerpilot.mjs resume-style-show [--root PATH]',
      'node careerpilot.mjs resume-style-set --stdin [--root PATH]',
      'node careerpilot.mjs resume-tailoring-show PREVIEW_ID [--root PATH]',
    ],
  };
}

async function main() {
  const {
    attachEvidence,
    auditCandidateProfile,
    auditProjectedCv,
    buildJobMatchContext,
    importCvMarkdown,
    loadCandidateProfile,
    migrateCandidateProfile,
    previewCv,
    projectCv,
    updateFactStatus,
    updateStructuredProfile,
    validateCandidateProfile,
  } = await import('./lib/careerpilot/profile-core.mjs');
  const loadResumeCore = () => import('./lib/careerpilot/resume-core.mjs');
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
    case 'job-context':
      process.stdout.write(`${JSON.stringify(buildJobMatchContext(root))}\n`);
      return;
    case 'campaign-create': {
      if (!args.includes('--stdin')) throw new Error('campaign-create requires --stdin');
      const { createCampaign } = await import('./lib/careerpilot/campaign-core.mjs');
      process.stdout.write(`${JSON.stringify({ campaign: createCampaign(root, JSON.parse(await readStdin())) })}\n`);
      return;
    }
    case 'campaign-import': {
      if (!args.includes('--stdin')) throw new Error('campaign-import requires --stdin');
      const { importCampaignSources } = await import('./lib/careerpilot/campaign-core.mjs');
      const payload = JSON.parse(await readStdin());
      const sources = Array.isArray(payload) ? payload : payload.sources;
      const result = await importCampaignSources(root, required(option(args, '--campaign'), '--campaign'), sources, {
        allowedRoot: option(args, '--allowed-root'),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    case 'campaign-rank': {
      const { rankCampaign } = await import('./lib/careerpilot/campaign-core.mjs');
      process.stdout.write(`${JSON.stringify({ campaign: rankCampaign(root, required(option(args, '--campaign'), '--campaign')) })}\n`);
      return;
    }
    case 'campaign-select': {
      if (!args.includes('--stdin')) throw new Error('campaign-select requires --stdin');
      const { selectCampaignJobs } = await import('./lib/careerpilot/campaign-core.mjs');
      const supplied = JSON.parse(await readStdin());
      const jobIds = required(option(args, '--job'), '--job').split(',').map((item) => item.trim()).filter(Boolean);
      process.stdout.write(`${JSON.stringify({ campaign: selectCampaignJobs(root, required(option(args, '--campaign'), '--campaign'), jobIds, supplied) })}\n`);
      return;
    }
    case 'campaign-exclude': {
      if (!args.includes('--stdin')) throw new Error('campaign-exclude requires --stdin');
      const { excludeCampaignJob } = await import('./lib/careerpilot/campaign-core.mjs');
      process.stdout.write(`${JSON.stringify({ campaign: excludeCampaignJob(
        root,
        required(option(args, '--campaign'), '--campaign'),
        required(option(args, '--job'), '--job'),
        JSON.parse(await readStdin()),
      ) })}\n`);
      return;
    }
    case 'campaign-show': {
      const { loadCampaign } = await import('./lib/careerpilot/campaign-core.mjs');
      process.stdout.write(`${JSON.stringify({ campaign: loadCampaign(root, required(positionals[0], 'CAMPAIGN_ID')) })}\n`);
      return;
    }
    case 'campaign-list': {
      const { listCampaigns } = await import('./lib/careerpilot/campaign-core.mjs');
      process.stdout.write(`${JSON.stringify({ campaigns: listCampaigns(root) })}\n`);
      return;
    }
    case 'campaign-constraints': {
      if (!args.includes('--stdin')) throw new Error('campaign-constraints requires --stdin');
      const { confirmCampaignConstraints } = await import('./lib/careerpilot/campaign-core.mjs');
      const campaign = confirmCampaignConstraints(root, required(option(args, '--campaign'), '--campaign'), JSON.parse(await readStdin()));
      process.stdout.write(`${JSON.stringify({ campaign })}\n`);
      return;
    }
    case 'capabilities': {
      const { inspectRuntimeCapabilities } = await import('./lib/careerpilot/runtime-core.mjs');
      const declarations = args.includes('--stdin') ? JSON.parse(await readStdin()) : {};
      process.stdout.write(`${JSON.stringify(await inspectRuntimeCapabilities(root, declarations))}\n`);
      return;
    }
    case 'cleanup': {
      const { cleanupCareerPilotRuns } = await import('./lib/careerpilot/cleanup-core.mjs');
      if (args.includes('--apply') === args.includes('--dry-run')) throw new Error('cleanup requires exactly one of --dry-run or --apply');
      const result = cleanupCareerPilotRuns(root, {
        apply: args.includes('--apply'),
        olderThanDays: Number(required(option(args, '--older-than'), '--older-than')),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    case 'profile-structure': {
      if (!args.includes('--stdin')) throw new Error('profile-structure requires --stdin');
      const payload = JSON.parse(await readStdin());
      const structured = payload?.structured || payload;
      process.stdout.write(`${JSON.stringify(updateStructuredProfile(root, structured, { authorizeUses: payload?.authorize_uses === true }))}\n`);
      return;
    }
    case 'migrate-profile':
      process.stdout.write(`${JSON.stringify(migrateCandidateProfile(root))}\n`);
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
    case 'resume-preview': {
      const { createResumeVariant, renderResumeHtml, renderResumeMarkdown } = await loadResumeCore();
      const supplied = args.includes('--stdin') ? JSON.parse(await readStdin()) : {};
      const variant = createResumeVariant(root, args.includes('--stdin') ? supplied : {
          template: option(args, '--template', 'soe-one-page'),
          sensitive_authorizations: {
            photo: args.includes('--authorize-photo'),
            political_status: args.includes('--authorize-political-status'),
          },
        });
      process.stdout.write(`${JSON.stringify({
        variant,
        markdown: renderResumeMarkdown(root, variant),
        html: renderResumeHtml(root, variant),
      })}\n`);
      return;
    }
    case 'resume-save': {
      const { createResumeVariant, saveResumeVariant } = await loadResumeCore();
      const variant = createResumeVariant(root, {
        template: option(args, '--template', 'soe-one-page'),
        sensitive_authorizations: {
          photo: args.includes('--authorize-photo'),
          political_status: args.includes('--authorize-political-status'),
        },
        status: 'draft',
      });
      process.stdout.write(`${JSON.stringify({ variant, path: saveResumeVariant(root, variant) })}\n`);
      return;
    }
    case 'resume-confirm': {
      if (!args.includes('--stdin')) throw new Error('resume-confirm requires --stdin');
      const { confirmResumeVariant } = await loadResumeCore();
      process.stdout.write(`${JSON.stringify(confirmResumeVariant(root, JSON.parse(await readStdin())))}\n`);
      return;
    }
    case 'resume-export': {
      if (!args.includes('--variant-stdin')) throw new Error('resume-export requires a previewed and confirmed ResumeVariant via --variant-stdin');
      const { exportResume } = await loadResumeCore();
      const variant = JSON.parse(await readStdin());
      const result = await exportResume(
        root,
        variant,
        required(option(args, '--format'), '--format'),
        option(args, '--output'),
      );
      process.stdout.write(`${JSON.stringify({ variant, ...result })}\n`);
      return;
    }
    case 'job-parse': {
      const { inferJobPosting, parseJobFile, parseJobUrl } = await import('./lib/careerpilot/job-core.mjs');
      let posting;
      if (args.includes('--file')) {
        const allowedRoot = option(args, '--allowed-root');
        posting = await parseJobFile(required(option(args, '--file'), '--file'), allowedRoot ? { allowed_root: allowedRoot } : {});
      } else if (args.includes('--url')) {
        posting = await parseJobUrl(required(option(args, '--url'), '--url'));
      } else if (args.includes('--stdin')) {
        const input = await readStdin();
        let payload = null;
        try { payload = JSON.parse(input); } catch { /* raw JD text */ }
        posting = payload && typeof payload === 'object'
          ? inferJobPosting(required(payload.raw_text, 'raw_text'), payload.source || { kind: 'pasted_text' }, payload.hints || {})
          : inferJobPosting(input);
      } else {
        throw new Error('job-parse requires --stdin, --file, or --url');
      }
      process.stdout.write(`${JSON.stringify(posting)}\n`);
      return;
    }
    case 'job-evaluate': {
      if (!args.includes('--stdin')) throw new Error('job-evaluate requires --stdin');
      const { evaluateJob, finalizeJobPosting, saveJobEvaluation } = await import('./lib/careerpilot/job-core.mjs');
      const payload = JSON.parse(await readStdin());
      const posting = finalizeJobPosting(required(payload.posting, 'posting'));
      const report = evaluateJob(root, posting, payload);
      const paths = args.includes('--no-persist') ? null : saveJobEvaluation(root, posting, report);
      process.stdout.write(`${JSON.stringify({ posting, report, paths })}\n`);
      return;
    }
    case 'job-confirm': {
      if (!args.includes('--stdin')) throw new Error('job-confirm requires --stdin');
      const { confirmJobPosting } = await import('./lib/careerpilot/job-core.mjs');
      const payload = JSON.parse(await readStdin());
      const posting = confirmJobPosting(required(payload.posting, 'posting'), {
        official_source_confirmed: payload.official_source_confirmed === true,
        official_source_evidence: payload.official_source_evidence,
      });
      process.stdout.write(`${JSON.stringify(posting)}\n`);
      return;
    }
    case 'job-proposal-validate': {
      if (!args.includes('--stdin')) throw new Error('job-proposal-validate requires --stdin');
      const { validateFitProposal } = await import('./lib/careerpilot/job-core.mjs');
      process.stdout.write(`${JSON.stringify(validateFitProposal(root, JSON.parse(await readStdin())))}\n`);
      return;
    }
    case 'job-show': {
      const { loadJobRecord } = await import('./lib/careerpilot/job-core.mjs');
      process.stdout.write(`${JSON.stringify(loadJobRecord(root, required(positionals[0], 'JOB_ID')))}\n`);
      return;
    }
    case 'resume-tailor-preview': {
      const { createTailoringPreview, saveTailoringPreview } = await import('./lib/careerpilot/tailoring-core.mjs');
      const supplied = args.includes('--stdin') ? JSON.parse(await readStdin()) : {};
      const preview = createTailoringPreview(
        root,
        required(option(args, '--job'), '--job'),
        { ...supplied, baseline_variant_id: option(args, '--baseline', supplied.baseline_variant_id) },
      );
      const path = args.includes('--save') ? saveTailoringPreview(root, preview) : null;
      process.stdout.write(`${JSON.stringify({ preview, path })}\n`);
      return;
    }
    case 'resume-tailor-export': {
      if (!args.includes('--stdin')) throw new Error('resume-tailor-export requires --stdin');
      const { exportCampaignTailoredResume, exportTailoredResume } = await import('./lib/careerpilot/tailoring-core.mjs');
      const preview = JSON.parse(await readStdin());
      const campaignId = option(args, '--campaign');
      const result = campaignId
        ? await exportCampaignTailoredResume(root, campaignId, preview, required(option(args, '--format'), '--format'), option(args, '--output'))
        : await exportTailoredResume(root, preview, required(option(args, '--format'), '--format'), option(args, '--output'));
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    case 'application-prepare': {
      const { prepareApplication } = await import('./lib/careerpilot/application-core.mjs');
      const supplied = args.includes('--stdin') ? JSON.parse(await readStdin()) : {};
      const result = await prepareApplication(root, required(option(args, '--job'), '--job'), supplied);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    case 'application-stage': {
      const { updateApplicationStage } = await import('./lib/careerpilot/application-core.mjs');
      const result = await updateApplicationStage(root, Number(required(positionals[0], 'TRACKER_NUM')), required(positionals[1], 'STAGE'), {
        note: option(args, '--note'), external_submission_confirmed: args.includes('--external-submission-confirmed'),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }
    case 'application-show': {
      const { loadApplication, reconcileApplication } = await import('./lib/careerpilot/application-core.mjs');
      const trackerNum = Number(required(positionals[0], 'TRACKER_NUM'));
      process.stdout.write(`${JSON.stringify({ application: loadApplication(root, trackerNum), reconciliation: reconcileApplication(root, trackerNum) })}\n`);
      return;
    }
    case 'application-fields': {
      if (!args.includes('--stdin')) throw new Error('application-fields requires --stdin');
      const { updateApplicationFields } = await import('./lib/careerpilot/application-core.mjs');
      const updates = JSON.parse(await readStdin());
      process.stdout.write(`${JSON.stringify({ application: await updateApplicationFields(root, Number(required(positionals[0], 'TRACKER_NUM')), updates) })}\n`);
      return;
    }
    case 'application-list': {
      const { listApplications } = await import('./lib/careerpilot/application-core.mjs');
      process.stdout.write(`${JSON.stringify({ applications: listApplications(root) })}\n`);
      return;
    }
    case 'resume-list': {
      const { listResumeVariants } = await import('./lib/careerpilot/tailoring-core.mjs');
      process.stdout.write(`${JSON.stringify({ variants: listResumeVariants(root, { approvedOnly: args.includes('--approved') }) })}\n`);
      return;
    }
    case 'resume-variant-show': {
      const { resumeVariantContext } = await import('./lib/careerpilot/tailoring-core.mjs');
      process.stdout.write(`${JSON.stringify(resumeVariantContext(root, required(positionals[0], 'VARIANT_ID')))}\n`);
      return;
    }
    case 'resume-workspace': {
      const { listResumeWorkspace } = await import('./lib/careerpilot/tailoring-core.mjs');
      process.stdout.write(`${JSON.stringify(listResumeWorkspace(root))}\n`);
      return;
    }
    case 'resume-style-show': {
      const { loadResumeStyle } = await import('./lib/careerpilot/resume-style-core.mjs');
      process.stdout.write(`${JSON.stringify({ style: loadResumeStyle(root) })}\n`);
      return;
    }
    case 'resume-style-set': {
      if (!args.includes('--stdin')) throw new Error('resume-style-set requires --stdin');
      const { saveResumeStyle } = await import('./lib/careerpilot/resume-style-core.mjs');
      process.stdout.write(`${JSON.stringify(saveResumeStyle(root, JSON.parse(await readStdin())))}\n`);
      return;
    }
    case 'resume-tailoring-show': {
      const { loadTailoringPreview } = await import('./lib/careerpilot/tailoring-core.mjs');
      process.stdout.write(`${JSON.stringify(loadTailoringPreview(root, required(positionals[0], 'PREVIEW_ID')))}\n`);
      return;
    }
    case 'resume-tailor-suggest': {
      const { generateTailoringRewriteCandidates } = await import('./lib/careerpilot/tailoring-core.mjs');
      process.stdout.write(`${JSON.stringify(generateTailoringRewriteCandidates(
        root,
        required(option(args, '--job'), '--job'),
        required(option(args, '--baseline'), '--baseline'),
      ))}\n`);
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
