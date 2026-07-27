#!/usr/bin/env node

import assert from 'node:assert/strict';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const pageBudgets = new Map([
  ['soe-one-page', 1],
  ['tech-two-page', 2],
]);

if (process.argv.length < 3) throw new Error('Usage: node verify-pdf-qa.mjs <pdf> [...]');

for (const path of process.argv.slice(2)) {
  const template = [...pageBudgets.keys(), 'application-detail'].find((id) => path.includes(id));
  assert.ok(template, `Cannot infer resume template from ${path}`);
  const pdf = await getDocument({ url: path }).promise;
  const budget = pageBudgets.get(template);
  if (budget) assert.ok(pdf.numPages <= budget, `${template} exceeded ${budget} page(s): ${pdf.numPages}`);
  let text = '';
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str).join(' ').trim();
    assert.ok(pageText.length > 0, `${template} contains a blank page: ${pageNumber}`);
    text += `${pageText}\n`;
  }
  assert.ok(text.length >= 30, `${template} extracted too little selectable text`);
  assert.match(text, /匿名候选人/, `${template} Chinese title is not extractable`);
  assert.doesNotMatch(text, /�/, `${template} contains Unicode replacement characters`);
  console.log(`PASS ${template}: ${pdf.numPages} page(s), ${text.trim().length} selectable characters`);
}
