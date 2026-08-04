import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

const REGISTERED_ROOTS = Object.freeze([
  'output/careerpilot/qa',
  'output/careerpilot/qa-anonymous-workspace',
  'output/careerpilot/failed-runs',
  'tmp/careerpilot',
  'tmp/pdfs',
]);

function safeChildren(root, relativeRoot) {
  const absoluteRoot = resolve(root, ...relativeRoot.split('/'));
  if (!existsSync(absoluteRoot) || lstatSync(absoluteRoot).isSymbolicLink() || !lstatSync(absoluteRoot).isDirectory()) return [];
  const realRoot = realpathSync(absoluteRoot);
  return readdirSync(realRoot).flatMap((name) => {
    const path = join(realRoot, name);
    const childRelative = relative(realRoot, path);
    if (!childRelative || childRelative.startsWith('..') || isAbsolute(childRelative)) return [];
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) return [];
    return [{ path, relative_path: `${relativeRoot}/${name}`.replaceAll('\\', '/'), modified_at: statSync(path).mtime.toISOString() }];
  });
}

export function cleanupCareerPilotRuns(root, options = {}) {
  const days = Number(options.olderThanDays ?? 7);
  if (!Number.isFinite(days) || days < 0) throw new Error('olderThanDays must be a non-negative number');
  const now = options.now instanceof Date ? options.now : new Date();
  const cutoff = now.getTime() - days * 86_400_000;
  const targets = REGISTERED_ROOTS.flatMap((directory) => safeChildren(root, directory))
    .filter((item) => new Date(item.modified_at).getTime() < cutoff)
    .sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  const deleted = [];
  if (options.apply === true) {
    for (const target of targets) {
      rmSync(target.path, { recursive: true, force: true });
      deleted.push(target.relative_path);
    }
  }
  return { mode: options.apply === true ? 'apply' : 'dry-run', older_than_days: days, targets: targets.map(({ path, ...item }) => item), deleted };
}
