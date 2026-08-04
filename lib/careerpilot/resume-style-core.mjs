import Ajv2020 from 'ajv/dist/2020.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema = JSON.parse(readFileSync(join(ROOT, 'schemas', 'cn', 'resume-style.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

export const DEFAULT_RESUME_STYLE = Object.freeze({
  schema_version: 1, preset: 'compact-no-photo', density: 'balanced', font_family: 'Microsoft YaHei',
  font_size_pt: 9, page_margin_cm: 1.1,
  section_order: ['教育经历', '实习与工作经历', '专业技能', '项目经历', '证书与奖项', '校园经历', '基本信息'],
  project_bullet_limit: 4,
  photo: { enabled: false, crop: 'center-3x4', width_cm: 2.55, height_cm: 3.4 },
});

export function validateResumeStyle(style) {
  const errors = [];
  if (!validateSchema(style)) errors.push(...(validateSchema.errors || []).map((item) => ({ code: 'schema_invalid', path: item.instancePath || '/', message: item.message })));
  if (style?.preset === 'compact-photo' && style?.photo?.enabled !== true) errors.push({ code: 'photo_preset_requires_photo' });
  if (style?.preset === 'compact-no-photo' && style?.photo?.enabled !== false) errors.push({ code: 'no_photo_preset_forbids_photo' });
  return { valid: errors.length === 0, errors };
}

export function loadResumeStyle(root) {
  const path = join(root, 'profile', 'resume-style.yml');
  const style = existsSync(path) ? yaml.load(readFileSync(path, 'utf8')) : structuredClone(DEFAULT_RESUME_STYLE);
  const validation = validateResumeStyle(style);
  if (!validation.valid) {
    const error = new Error('Resume style profile is invalid');
    error.code = 'RESUME_STYLE_INVALID';
    error.details = validation.errors;
    throw error;
  }
  return style;
}

export function saveResumeStyle(root, style) {
  const validation = validateResumeStyle(style);
  if (!validation.valid) {
    const error = new Error('Resume style profile is invalid');
    error.code = 'RESUME_STYLE_INVALID';
    error.details = validation.errors;
    throw error;
  }
  const path = join(root, 'profile', 'resume-style.yml');
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, yaml.dump(style, { noRefs: true, lineWidth: 120 }), 'utf8');
  renameSync(temporary, path);
  return { style: loadResumeStyle(root), path };
}
