// The Go half of a port's dependencies (computed in CI by scripts/ports/touched.mjs, not stored):
// `go list -deps` from the port's Go roots, restricted to the service's own module, as repo-relative
// files (non-test Go files and embedded files), plus the handler files and the module's go.mod / go.sum.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const toPosix = (p) => p.split(path.sep).join('/');

// One target platform and no cgo, so the build-constrained file set is the same on every machine.
export const GO_ENV = {
  GOOS: 'linux',
  GOARCH: 'amd64',
  CGO_ENABLED: '0',
  GOFLAGS: '-mod=readonly',
};

const FORMAT =
  '{{.ImportPath}}\t{{.Dir}}\t{{join .GoFiles ","}}\t{{join .EmbedFiles ","}}\t{{if .Error}}{{.Error.Err}}{{end}}\x1e';

export function modulePath(moduleDirAbs) {
  const m = /^module\s+(\S+)/m.exec(readFileSync(path.join(moduleDirAbs, 'go.mod'), 'utf8'));
  if (!m) throw new Error(`${moduleDirAbs}/go.mod: no module line`);
  return m[1];
}

function defaultGoList(moduleDirAbs, pkgs) {
  return execFileSync('go', ['list', '-e', '-deps', '-f', FORMAT, ...pkgs], {
    cwd: moduleDirAbs,
    encoding: 'utf8',
    env: { ...process.env, ...GO_ENV },
    maxBuffer: 64 << 20,
  });
}

/**
 * @param root repo root
 * @param moduleDir repo-relative module directory (holds go.mod), e.g. `apps/feed-go`
 * @param roots repo-relative package directories to list from
 * @param handlerFiles repo-relative handler files, always included
 * @param goList injectable `go list` runner (tests)
 */
export function computeGoDeps(root, moduleDir, roots, handlerFiles = [], goList = defaultGoList) {
  const moduleAbs = path.resolve(root, moduleDir);
  const mod = modulePath(moduleAbs);
  const pkgs = roots.map((r) => {
    const rel = toPosix(path.relative(moduleDir, r));
    if (rel.startsWith('..')) throw new Error(`Go root ${r} is outside module ${moduleDir}`);
    return rel === '' ? '.' : `./${rel}`;
  });
  const out = goList(moduleAbs, pkgs);
  // `go list` prints real paths.
  const rootReal = realpathSync(root);
  const files = new Set(handlerFiles);
  for (const f of ['go.mod', 'go.sum'])
    if (existsSync(path.join(moduleAbs, f))) files.add(`${moduleDir}/${f}`);
  const errors = [];
  // Records end in \x1e: an error message can span lines.
  for (const record of out.split('\x1e')) {
    const line = record.replace(/^\n/, '');
    if (!line.trim()) continue;
    const [importPath, dir, goFiles, embedFiles, err] = line.split('\t');
    if (importPath !== mod && !importPath.startsWith(`${mod}/`)) continue;
    if (err) errors.push(`${importPath}: ${err}`);
    const relDir = toPosix(path.relative(rootReal, dir));
    for (const f of [
      ...(goFiles ? goFiles.split(',') : []),
      ...(embedFiles ? embedFiles.split(',') : []),
    ])
      files.add(`${relDir}/${f}`);
  }
  if (errors.length) throw new Error(`go list errors in ${mod}:\n  ${errors.join('\n  ')}`);
  return [...files].sort();
}
