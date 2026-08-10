import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

function qaError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function searchable(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function multiplyMatrix(left, right) {
  const [a1, b1, c1, d1, e1, f1] = left;
  const [a2, b2, c2, d2, e2, f2] = right;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

function transformedBounds(matrix) {
  const points = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => ({
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  }));
  return {
    left: Math.min(...points.map((point) => point.x)),
    right: Math.max(...points.map((point) => point.x)),
    bottom: Math.min(...points.map((point) => point.y)),
    top: Math.max(...points.map((point) => point.y)),
  };
}

async function inspectPageGeometry(page, content) {
  const [pageLeft, pageBottom, pageRight, pageTop] = page.view;
  const textBoxes = content.items.filter((item) => 'str' in item && item.str.trim()).map((item) => {
    const height = Math.max(Number(item.height || 0), Math.hypot(item.transform[2], item.transform[3]), 1);
    return {
      left: item.transform[4], right: item.transform[4] + Math.max(Number(item.width || 0), 0),
      bottom: item.transform[5] - height * 0.25, top: item.transform[5] + height * 0.8,
    };
  });
  const operatorList = await page.getOperatorList();
  let transform = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const imageBoxes = [];
  const imageOperators = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintSolidColorImageMask]);
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    const args = operatorList.argsArray[index] || [];
    if (operation === OPS.save) stack.push([...transform]);
    else if (operation === OPS.restore) transform = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (operation === OPS.transform) transform = multiplyMatrix(transform, args);
    else if (imageOperators.has(operation)) imageBoxes.push(transformedBounds(transform));
  }
  const tolerance = 2;
  const outOfBounds = [...textBoxes, ...imageBoxes].filter((box) => (
    box.left < pageLeft - tolerance || box.right > pageRight + tolerance
    || box.bottom < pageBottom - tolerance || box.top > pageTop + tolerance
  ));
  const overlaps = [];
  for (let leftIndex = 0; leftIndex < textBoxes.length; leftIndex += 1) {
    const left = textBoxes[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < textBoxes.length; rightIndex += 1) {
      const right = textBoxes[rightIndex];
      const horizontal = Math.min(left.right, right.right) - Math.max(left.left, right.left);
      const vertical = Math.min(left.top, right.top) - Math.max(left.bottom, right.bottom);
      if (horizontal > 2 && vertical > 0.5 * Math.min(left.top - left.bottom, right.top - right.bottom)) overlaps.push([leftIndex, rightIndex]);
    }
  }
  const allBoxes = [...textBoxes, ...imageBoxes];
  const verticalFill = allBoxes.length
    ? (Math.max(...allBoxes.map((box) => box.top)) - Math.min(...allBoxes.map((box) => box.bottom))) / (pageTop - pageBottom)
    : 0;
  return { imageBoxes, outOfBounds, overlaps, verticalFill, page: { left: pageLeft, right: pageRight, bottom: pageBottom, top: pageTop } };
}

export async function verifyRenderedResumePdf(pdfPath, options = {}) {
  const bytes = readFileSync(pdfPath);
  const loadingTask = getDocument({ data: new Uint8Array(bytes) });
  const document = await loadingTask.promise;
  const pageCount = document.numPages;
  const pages = [];
  const geometry = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ').trim();
      if (!text) throw qaError('RESUME_TEXT_LAYER_MISSING', `Resume page ${pageNumber} has no selectable text`);
      pages.push(text);
      geometry.push(await inspectPageGeometry(page, content));
    }
  } finally {
    await loadingTask.destroy();
  }

  const pageBudget = Number(options.pageBudget || 1);
  if (pageCount > pageBudget) {
    throw qaError('PAGE_BUDGET_EXCEEDED', `Resume rendered to ${pageCount} pages; budget is ${pageBudget}`, {
      page_count: pageCount,
      page_budget: pageBudget,
    });
  }
  const text = pages.join('\n');
  if (text.length < 30 || text.includes('\uFFFD')) throw qaError('RESUME_TEXT_LAYER_INVALID', 'Resume PDF text layer is empty or damaged');
  const haystack = searchable(text);
  if (options.targetJobTitle && !haystack.includes(searchable(options.targetJobTitle))) {
    throw qaError('RESUME_TARGET_MISMATCH', 'Rendered resume title does not match the selected job');
  }
  const missingFacts = (options.expectedStatements || [])
    .filter((statement) => {
      const expected = searchable(statement);
      return expected.length >= 4 && !haystack.includes(expected);
    });
  if (missingFacts.length) {
    throw qaError('RESUME_SEMANTIC_MISMATCH', 'Rendered resume is missing confirmed Fact content', { missing_facts: missingFacts });
  }
  const clipped = geometry.flatMap((page) => page.outOfBounds);
  if (clipped.length) throw qaError('RESUME_CONTENT_CLIPPED', 'Resume contains text or images outside the page bounds', {
    element_count: clipped.length,
    sample_bounds: clipped.slice(0, 3),
  });
  const overlaps = geometry.flatMap((page) => page.overlaps);
  if (overlaps.length) throw qaError('RESUME_CONTENT_OVERLAP', 'Resume contains overlapping text elements', { overlap_count: overlaps.length });
  const minimumVerticalFill = Number(options.minimumVerticalFill ?? (options.density === 'full' ? 0.25 : 0.18));
  if (pageCount === 1 && geometry[0].verticalFill < minimumVerticalFill) {
    throw qaError('RESUME_ABNORMAL_WHITESPACE', 'Resume leaves an abnormal amount of unused vertical space', { vertical_fill: geometry[0].verticalFill, minimum: minimumVerticalFill });
  }
  let photoAspectRatio = null;
  if (options.photoExpected) {
    const expectedRatio = Number(options.expectedPhotoAspectRatio || 0.75);
    const candidates = geometry.flatMap((page) => page.imageBoxes.map((box) => ({
      ...box,
      ratio: (box.right - box.left) / Math.max(box.top - box.bottom, 0.001),
    })));
    if (!candidates.length) throw qaError('RESUME_PHOTO_MISSING', 'Authorized photo is absent from the rendered resume');
    const photo = candidates.sort((left, right) => Math.abs(left.ratio - expectedRatio) - Math.abs(right.ratio - expectedRatio))[0];
    photoAspectRatio = photo.ratio;
    if (Math.abs(photo.ratio - expectedRatio) / expectedRatio > 0.2) {
      throw qaError('RESUME_PHOTO_RATIO_INVALID', 'Rendered photo aspect ratio differs from the authorized style', { actual: photo.ratio, expected: expectedRatio });
    }
  }
  return {
    page_count: pageCount,
    page_budget: pageBudget,
    text_layer: 'verified',
    render_status: 'verified',
    truncation: 'verified',
    overlap: 'verified',
    whitespace: 'verified',
    photo_presence: options.photoExpected ? 'verified' : 'not_applicable',
    photo_aspect_ratio: photoAspectRatio,
    photo_bounds: options.photoExpected ? 'verified' : 'not_applicable',
  };
}

function resolveSoffice() {
  const candidates = [
    process.env.CAREERPILOT_SOFFICE,
    'E:\\liberoffice\\program\\soffice.com',
    'soffice',
  ].filter(Boolean);
  return candidates.find((candidate) => candidate === 'soffice' || existsSync(candidate)) || null;
}

export async function verifyRenderedResumeDocx(docxPath, options = {}) {
  if (extname(docxPath).toLowerCase() !== '.docx') throw qaError('DOCX_QA_INPUT_INVALID', 'DOCX QA requires a .docx file');
  const soffice = resolveSoffice();
  if (!soffice) throw qaError('DOCX_QA_UNAVAILABLE', 'LibreOffice command-line runtime is unavailable');
  const runRoot = mkdtempSync(join(tmpdir(), 'cpqa-'));
  const outputDir = join(runRoot, 'out');
  const profileDir = join(runRoot, 'lo');
  try {
    const result = spawnSync(soffice, [
      '--headless',
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      '--convert-to', 'pdf',
      '--outdir', outputDir,
      docxPath,
    ], { encoding: 'utf8', timeout: 90_000, windowsHide: true });
    if (result.error || result.status !== 0) {
      throw qaError('DOCX_QA_CONVERSION_FAILED', 'LibreOffice could not render the DOCX', {
        stderr: String(result.stderr || result.error?.message || '').trim(),
      });
    }
    const pdfPath = join(outputDir, `${basename(docxPath, extname(docxPath))}.pdf`);
    if (!existsSync(pdfPath)) throw qaError('DOCX_QA_CONVERSION_FAILED', 'LibreOffice did not produce the expected PDF');
    return await verifyRenderedResumePdf(pdfPath, options);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
}
