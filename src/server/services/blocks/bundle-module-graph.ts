import { parse } from 'acorn';
import { Parser } from 'htmlparser2';
import { APP_STATIC_SERVER_JS_EXTENSIONS } from '~/shared/constants/app-static-server.constants';

/**
 * SUBMIT-TIME MODULE-GRAPH LINT for App Block bundles.
 *
 * A browser runs an ES module only when its response has a JavaScript content type. The app
 * static server sends that type for the extensions in `APP_STATIC_SERVER_JS_EXTENSIONS` and
 * nothing else, so an app whose module graph imports `./main.ts`, `./App.tsx` or a file it never
 * shipped loads its page, answers 200 everywhere, and never starts. This lint finds that at
 * submit, names the file, and refuses, so the author learns why before any build or review.
 *
 * WHAT IS CHECKED: the graph a browser would load, from the entry `index.html`: every
 * `<script type="module" src>` and inline module script, then every static `import` / `export
 * … from` and every string-literal dynamic `import()` of each module reached, recursively.
 * Each relative or root-absolute specifier must resolve to a shipped file whose extension the
 * server sends as JavaScript. A bare specifier (`'react'`) must be mapped by the page's import
 * map, since a browser cannot resolve it otherwise. Full URLs are not checked. A module with an
 * import attribute (`with { type: 'json' }`) is checked for existence only. A DYNAMIC `import()`
 * is refused only for a shipped non-JavaScript target: a missing or bare one may sit behind a
 * code path that never runs (measured: a live app loads dev-only mocks it does not ship).
 *
 * Files the page never loads (build scripts, tests, tooling) are NOT checked: Node tooling in
 * a bundle can import `.ts` or `node:fs` legitimately.
 *
 * WHEN: only for a NO-BUILD bundle (no `buildCommand`), whose files are served as shipped. A
 * bundle with a `buildCommand` ships its source, and the served output does not exist until the
 * platform builds it: its source graph (`./main.tsx`, `'react'`) is what a bundler consumes, so
 * linting it would refuse every bundled app. The review boot check covers built apps.
 *
 * FAIL-OPEN on anything it cannot read: a module that does not parse is skipped, never refused.
 */

export type ModuleGraphProblem =
  | { kind: 'non-js-extension'; importer: string; specifier: string; resolved: string }
  | { kind: 'missing'; importer: string; specifier: string; resolved: string }
  | { kind: 'bare-specifier'; importer: string; specifier: string };

export type ModuleGraphResult =
  | { status: 'skipped'; reason: string; problems: [] }
  | {
      status: 'checked';
      problems: ModuleGraphProblem[];
      /** Modules parsed, the entry page included. */
      modulesChecked: number;
      /** Modules reached that did not parse (skipped, never refused). */
      unparsed: string[];
    };

/** The bundle as the lint reads it. `read` answers null for a file that is not shipped. */
export type ModuleGraphSource = {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string | null>;
};

const ENTRY = 'index.html';
const JS_EXTENSIONS: ReadonlySet<string> = new Set(APP_STATIC_SERVER_JS_EXTENSIONS);
const SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
/** Bounds a hostile bundle's graph; real apps are far below it. */
const MAX_MODULES = 2000;
const MAX_PROBLEMS = 50;

/** The extension of a path, lower case without the dot; '' for none. */
export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Whether the static server sends this path as JavaScript. */
export function isServedAsJavaScript(path: string): boolean {
  return JS_EXTENSIONS.has(extensionOf(path));
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i + 1);
}

/**
 * Resolve a path-like specifier against the importing file to a bundle-root-relative path, or
 * null when it climbs out of the bundle. The query and fragment are dropped (the server ignores
 * them).
 */
export function resolveBundlePath(importer: string, specifier: string): string | null {
  let spec = specifier.replace(/[?#].*$/, '');
  try {
    spec = decodeURIComponent(spec);
  } catch {
    /* keep it as written */
  }
  const joined = spec.startsWith('/') ? spec.slice(1) : dirOf(importer) + spec;
  const out: string[] = [];
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

type SpecifierKind = 'external' | 'path' | 'bare';

function specifierKind(spec: string): SpecifierKind {
  if (spec.startsWith('//') || SCHEME_RE.test(spec)) return 'external';
  if (spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../')) return 'path';
  return 'bare';
}

type ImportRef = {
  specifier: string;
  hasAttributes: boolean;
  /**
   * A dynamic `import()`. It runs only when its code path does, so a missing or bare target is
   * not refused (apps load dev-only modules they do not ship behind a flag). A target that IS
   * shipped with a non-JavaScript extension is refused: it can never run.
   */
  dynamic: boolean;
};

/** The string-literal module specifiers of one module's source, or null when it does not parse. */
export function moduleSpecifiers(source: string): ImportRef[] | null {
  let program: unknown;
  try {
    program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return null;
  }
  const refs: ImportRef[] = [];
  const literal = (node: unknown): string | null => {
    if (!node || typeof node !== 'object') return null;
    const n = node as {
      type?: string;
      value?: unknown;
      expressions?: unknown[];
      quasis?: { value: { cooked?: string } }[];
    };
    if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
    if (n.type === 'TemplateLiteral' && n.expressions?.length === 0)
      return n.quasis?.[0]?.value.cooked ?? null;
    return null;
  };
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    const n = node as Record<string, unknown> & { type?: string };
    if (
      n.type === 'ImportDeclaration' ||
      n.type === 'ExportNamedDeclaration' ||
      n.type === 'ExportAllDeclaration'
    ) {
      const spec = literal(n.source);
      if (spec !== null) {
        const attributes = n.attributes as unknown[] | undefined;
        refs.push({
          specifier: spec,
          hasAttributes: Array.isArray(attributes) && attributes.length > 0,
          dynamic: false,
        });
      }
    } else if (n.type === 'ImportExpression') {
      const spec = literal(n.source);
      if (spec !== null)
        refs.push({ specifier: spec, hasAttributes: n.options != null, dynamic: true });
    }
    for (const key of Object.keys(n)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      const value = n[key];
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(program);
  return refs;
}

type EntryPage = {
  moduleSrcs: string[];
  inlineModules: string[];
  importMapKeys: string[];
  importMapTargets: Map<string, string>;
};

/** The module scripts and import map of the entry page. */
export function readEntryPage(html: string): EntryPage {
  const page: EntryPage = {
    moduleSrcs: [],
    inlineModules: [],
    importMapKeys: [],
    importMapTargets: new Map(),
  };
  let current: { type: string; src?: string; text: string } | null = null;
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name !== 'script') return;
        current = { type: (attribs.type ?? '').trim().toLowerCase(), src: attribs.src, text: '' };
      },
      ontext(text) {
        if (current) current.text += text;
      },
      onclosetag(name) {
        if (name !== 'script' || !current) return;
        const script = current as { type: string; src?: string; text: string };
        current = null;
        if (script.type === 'module') {
          if (typeof script.src === 'string' && script.src.trim())
            page.moduleSrcs.push(script.src.trim());
          else if (script.text.trim()) page.inlineModules.push(script.text);
        } else if (script.type === 'importmap') {
          try {
            const map = JSON.parse(script.text) as {
              imports?: Record<string, unknown>;
              scopes?: Record<string, Record<string, unknown>>;
            };
            const tables = [map.imports ?? {}, ...Object.values(map.scopes ?? {})];
            for (const table of tables) {
              for (const [key, target] of Object.entries(table ?? {})) {
                page.importMapKeys.push(key);
                if (typeof target === 'string' && !page.importMapTargets.has(key))
                  page.importMapTargets.set(key, target);
              }
            }
          } catch {
            /* an unreadable import map maps nothing */
          }
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }
  );
  parser.write(html);
  parser.end();
  return page;
}

/** The import-map entry a bare specifier resolves through: an exact key, else the longest prefix key. */
function mappedTarget(page: EntryPage, spec: string): string | null | undefined {
  if (page.importMapTargets.has(spec)) return page.importMapTargets.get(spec) ?? null;
  let best: string | null = null;
  for (const key of page.importMapKeys) {
    if (key.endsWith('/') && spec.startsWith(key) && (!best || key.length > best.length))
      best = key;
  }
  if (!best) return undefined;
  const target = page.importMapTargets.get(best);
  return target ? target + spec.slice(best.length) : null;
}

/** Walk the module graph a browser loads from `index.html`. */
export async function checkModuleGraph(source: ModuleGraphSource): Promise<ModuleGraphResult> {
  const html = await source.read(ENTRY);
  if (html === null)
    return { status: 'skipped', reason: `no ${ENTRY} at the bundle root`, problems: [] };
  const page = readEntryPage(html);
  const problems: ModuleGraphProblem[] = [];
  const unparsed: string[] = [];
  const queued = new Set<string>();
  const queue: string[] = [];
  let modulesChecked = 1;

  const visit = async (importer: string, ref: ImportRef) => {
    if (problems.length >= MAX_PROBLEMS) return;
    let spec = ref.specifier;
    let base = importer;
    let kind = specifierKind(spec);
    if (kind === 'bare') {
      const target = mappedTarget(page, spec);
      if (target === undefined) {
        if (!ref.dynamic) problems.push({ kind: 'bare-specifier', importer, specifier: spec });
        return;
      }
      if (target === null) return; // mapped to something we cannot read: trust the map
      // Import-map targets resolve against the page, not the importer.
      spec = target;
      base = ENTRY;
      kind = specifierKind(spec);
      if (kind !== 'path') return;
    }
    if (kind === 'external') return;
    const resolved = resolveBundlePath(base, spec);
    if (resolved === null) {
      if (!ref.dynamic)
        problems.push({
          kind: 'missing',
          importer,
          specifier: ref.specifier,
          resolved: '(outside the bundle)',
        });
      return;
    }
    if (!(await source.exists(resolved))) {
      if (!ref.dynamic)
        problems.push({ kind: 'missing', importer, specifier: ref.specifier, resolved });
      return;
    }
    if (ref.hasAttributes) return; // a JSON / CSS module: its own content type
    if (!isServedAsJavaScript(resolved)) {
      problems.push({ kind: 'non-js-extension', importer, specifier: ref.specifier, resolved });
      return;
    }
    if (!queued.has(resolved) && queued.size < MAX_MODULES) {
      queued.add(resolved);
      queue.push(resolved);
    }
  };

  // A `<script src>` is a URL relative to the page, never a bare module specifier: `main.js`
  // there means `./main.js` (measured: a live app's entry is written that way).
  for (const src of page.moduleSrcs)
    await visit(ENTRY, {
      specifier: specifierKind(src) === 'bare' ? `./${src}` : src,
      hasAttributes: false,
      dynamic: false,
    });
  for (const inline of page.inlineModules) {
    const refs = moduleSpecifiers(inline);
    if (refs === null) unparsed.push(`${ENTRY} (inline module)`);
    else for (const ref of refs) await visit(ENTRY, ref);
  }
  while (queue.length > 0) {
    const path = queue.shift() as string;
    const text = await source.read(path);
    if (text === null) continue;
    modulesChecked++;
    const refs = moduleSpecifiers(text);
    if (refs === null) {
      unparsed.push(path);
      continue;
    }
    for (const ref of refs) await visit(path, ref);
  }
  return { status: 'checked', problems, modulesChecked, unparsed };
}

const SERVED_EXTS = APP_STATIC_SERVER_JS_EXTENSIONS.map((e) => `.${e}`);
const SERVED_TYPES = SERVED_EXTS.join(' and ');
const SERVED_CHOICE = SERVED_EXTS.join(' or ');

/** One problem as the sentence the author reads. */
export function describeModuleGraphProblem(p: ModuleGraphProblem): string {
  switch (p.kind) {
    case 'non-js-extension':
      return `${p.importer} imports "${p.specifier}" (${p.resolved}), but the app server sends only ${SERVED_TYPES} files as JavaScript, so the browser will not run it. Ship that module as ${SERVED_CHOICE} (build the app first, or set buildCommand and outputDir in the manifest so the platform builds it).`;
    case 'missing':
      return `${p.importer} imports "${p.specifier}", but ${p.resolved} is not in the bundle. Add the file or fix the import path.`;
    case 'bare-specifier':
      return `${p.importer} imports "${p.specifier}", a bare package name that a browser cannot load without an import map. Bundle the app (set buildCommand and outputDir in the manifest), map it in an import map, or import it by a relative path or full URL.`;
  }
}

const MESSAGE_PROBLEMS = 3;

/** The submit refusal. Its `problems` are returned to the client as `moduleGraphErrors`. */
export class ModuleGraphRefusal extends Error {
  readonly problems: ModuleGraphProblem[];
  constructor(problems: ModuleGraphProblem[]) {
    const shown = problems.slice(0, MESSAGE_PROBLEMS).map(describeModuleGraphProblem);
    const more = problems.length - shown.length;
    super(
      `This bundle's JavaScript would not load in the browser: ${shown.join(' ')}${
        more > 0 ? ` (${more} more problem${more === 1 ? '' : 's'} in moduleGraphErrors.)` : ''
      }`
    );
    this.name = 'ModuleGraphRefusal';
    this.problems = problems;
  }
}

export function isModuleGraphRefusal(err: unknown): err is ModuleGraphRefusal {
  return err instanceof ModuleGraphRefusal;
}

/** Whether the manifest asks the platform to build the bundle (so its files are source). */
export function bundleIsBuilt(manifest: Record<string, unknown>): boolean {
  return typeof manifest.buildCommand === 'string' && manifest.buildCommand.trim().length > 0;
}

/**
 * Lint a submitted ZIP and REFUSE it (`ModuleGraphRefusal`) when its module graph would not load.
 * Call after the bundle passed `extractBundleMetadata`, which caps its file count and sizes.
 */
export async function assertBundleModuleGraphLoads(
  bundleBuffer: Buffer,
  manifest: Record<string, unknown>
): Promise<ModuleGraphResult> {
  if (bundleIsBuilt(manifest)) {
    return {
      status: 'skipped',
      reason: 'the platform builds this bundle (buildCommand)',
      problems: [],
    };
  }
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bundleBuffer);
  const files = new Map(
    Object.entries(zip.files)
      .filter(([, entry]) => !entry.dir)
      .map(([path, entry]) => [path, entry] as const)
  );
  const result = await checkModuleGraph({
    exists: async (path) => files.has(path),
    read: async (path) => {
      const entry = files.get(path);
      return entry ? entry.async('string') : null;
    },
  });
  if (result.problems.length > 0) throw new ModuleGraphRefusal(result.problems);
  return result;
}
