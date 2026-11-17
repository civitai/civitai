import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Convention guard: the viewer an event gate is asked about, in a router or controller, is
 * `eventViewerOf(ctx)` or `eventUserOf(ctx)` (or a local every assignment binds to one), never the
 * session user; and the moderator flag a placement or the shop passes is
 * `eventViewerOf(ctx).isModerator`.
 *
 * Before an event launches only its flag audience sees its hats, and a moderator is in every flag
 * audience. `eventViewerOf` counts that only for a session or a full-access personal key, the same
 * rule moderatorProcedure applies. Passing `ctx.user` straight through skips it.
 *
 * If this fails: pass `eventViewerOf(ctx)` from ~/server/events/event-viewer.
 */

const SERVER_DIR = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['routers', 'controllers'].map((d) => path.join(SERVER_DIR, d));

/** Gates taking the viewer as an object field. */
const FIELD_GATES = [
  'getEventDecorationsForEntity',
  'getViewerEventDecorations',
  'getViewerEventAccess',
  'getNavBanners',
  'getHomeBlocks',
  'getHomeBlockById',
  'setHomeBlocksOrder',
  'getCollectionBlockAudience',
];
/** Gates taking the viewer as their second positional argument. */
const POSITIONAL_GATES = [
  'getVisibleDecorationEvents',
  'withoutHiddenEventDecorations',
  'filterViewableHomeBlocks',
  'markEventPointsWatched',
];
/** Every export of this module gates on the event: its `viewer` and `user` fields are viewers. */
const EVENT_SERVICE = '~/server/services/event.service';
/** Type arguments (`<T>`) may sit between a call's name and its `(`. */
const TYPE_ARGS = '\\s*(?:<[^()]*>)?\\s*';
const GATE_CALL = new RegExp(
  `\\b(${[...FIELD_GATES, ...POSITIONAL_GATES].join('|')})${TYPE_ARGS}\\(`,
  'g'
);
/** Gates taking the moderator flag rather than a viewer. */
const MODERATOR_FLAG_GATES = [
  'equipCosmeticToEntity',
  'getShopSectionsWithItems',
  'purchaseCosmeticShopItem',
];
const MODERATOR_FLAG_CALL = new RegExp(
  `\\b(${MODERATOR_FLAG_GATES.join('|')})${TYPE_ARGS}\\(`,
  'g'
);
const VIEWER_FIELD = /[{,]\s*eventDecorationViewer\b\s*(:\s*)?/g;
const EVENT_VIEWER_OF = /^event(?:Viewer|User)Of\(\s*ctx\s*\)/;

function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') walk(full, files);
    } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) files.push(full);
  }
  return files;
}

/** The text of a call's arguments, from just after its `(` to the matching `)`. */
function callArgs(source: string, openParen: number) {
  let depth = 1;
  for (let i = openParen + 1; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(openParen + 1, i);
  }
  return source.slice(openParen + 1);
}

/** The local names a file imports from `module` (aliases resolved, type-only imports skipped). */
function importedNames(source: string, module: string) {
  const names: string[] = [];
  const from = module.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  for (const m of source.matchAll(
    new RegExp(`import\\s+(type\\s+)?\\{([^}]*)\\}\\s*from\\s*'${from}'`, 'g')
  )) {
    if (m[1]) continue;
    for (const spec of m[2].split(',')) {
      const s = spec.trim();
      if (!s || s.startsWith('type ')) continue;
      names.push(
        s
          .split(/\s+as\s+/)
          .pop()!
          .trim()
      );
    }
  }
  return names;
}

/** Whether `id` is bound as a function or arrow parameter anywhere in the file. */
function isParameter(id: string, source: string) {
  const word = new RegExp(`\\b${id}\\b`);
  const lists = [
    ...source.matchAll(/\bfunction\b[^(]*\(([^)]*)\)/g),
    ...source.matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?::[^=;{]+)?=>/g),
  ].map((m) => m[1]);
  return lists.some((l) => word.test(l)) || new RegExp(`\\b${id}\\s*=>`).test(source);
}

/** A call's top-level arguments (commas inside brackets do not split). */
function topLevelArgs(args: string) {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      out.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(args.slice(start).trim());
  return out;
}

/**
 * Whether a value expression is the viewer eventViewerOf gives: the call itself, or an identifier
 * every assignment in the file binds to that call. `trailing` names what may follow it.
 */
function isEventViewer(value: string, source: string, trailing = '') {
  const v = value.trim();
  if (EVENT_VIEWER_OF.test(v)) return v.replace(EVENT_VIEWER_OF, '').trim() === trailing;
  const id = /^([A-Za-z_$][\w$]*)/.exec(v)?.[1];
  if (!id || v.slice(id.length).trim() !== trailing) return false;
  // A type annotation (`const viewer: EventViewer = ...`) may sit between the name and its `=`.
  const assignments = [
    ...source.matchAll(new RegExp(`\\b${id}\\s*(?::[^=;(){}]+)?=(?![=>])\\s*`, 'g')),
  ];
  // A parameter of that name is bound by its caller, not by these assignments.
  return (
    assignments.length > 0 &&
    !isParameter(id, source) &&
    assignments.every((a) => EVENT_VIEWER_OF.test(source.slice(a.index + a[0].length)))
  );
}

/** The value of a property starting at `at`, up to the next top-level `,` or closing bracket. */
function valueAt(source: string, at: number) {
  let depth = 0;
  for (let i = at; i < source.length; i++) {
    const c = source[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) return source.slice(at, i);
      depth--;
    } else if (c === ',' && depth === 0) return source.slice(at, i);
  }
  return source.slice(at);
}

function lineOf(source: string, index: number) {
  return source.slice(0, index).split('\n').length;
}

function findViolations(files: { name: string; text: string }[]) {
  const hits: string[] = [];
  for (const { name, text } of files) {
    const source = stripComments(text);
    const where = (index: number) => `${name}:${lineOf(source, index)}`;

    for (const m of source.matchAll(VIEWER_FIELD)) {
      // Shorthand `{ eventDecorationViewer }` names a local of that name.
      const value = m[1] ? valueAt(source, m.index + m[0].length) : 'eventDecorationViewer';
      if (!isEventViewer(value, source))
        hits.push(
          `${where(m.index + m[0].indexOf('eventDecorationViewer'))}: eventDecorationViewer`
        );
    }
    for (const m of source.matchAll(GATE_CALL)) {
      const args = callArgs(source, m.index + m[0].length - 1);
      if (FIELD_GATES.includes(m[1])) {
        for (const v of args.matchAll(/[{,]\s*viewer\b\s*(:\s*)?/g)) {
          const value = v[1] ? valueAt(args, v.index + v[0].length) : 'viewer';
          // `undefined` asks about a signed-out viewer.
          if (value.trim() !== 'undefined' && !isEventViewer(value, source))
            hits.push(`${where(m.index)}: ${m[1]} viewer`);
        }
      } else {
        const second = topLevelArgs(args)[1] ?? '';
        if (second && second !== 'undefined' && !isEventViewer(second, source))
          hits.push(`${where(m.index)}: ${m[1]} viewer`);
      }
    }
    for (const m of source.matchAll(MODERATOR_FLAG_CALL)) {
      const args = callArgs(source, m.index + m[0].length - 1);
      for (const v of args.matchAll(/[{,]\s*isModerator\b\s*(:\s*)?/g)) {
        const value = v[1] ? valueAt(args, v.index + v[0].length) : 'isModerator';
        if (!isEventViewer(value, source, '.isModerator'))
          hits.push(`${where(m.index)}: ${m[1]} isModerator`);
      }
    }
    const eventServiceFns = importedNames(source, EVENT_SERVICE).filter(
      (n) => !FIELD_GATES.includes(n)
    );
    if (eventServiceFns.length) {
      const call = new RegExp(`\\b(${eventServiceFns.join('|')})${TYPE_ARGS}\\(`, 'g');
      for (const m of source.matchAll(call)) {
        const args = callArgs(source, m.index + m[0].length - 1);
        for (const v of args.matchAll(/[{,]\s*(viewer|user)\b\s*(:\s*)?/g)) {
          const value = v[2] ? valueAt(args, v.index + v[0].length) : v[1];
          if (value.trim() !== 'undefined' && !isEventViewer(value, source))
            hits.push(`${where(m.index)}: ${m[1]} ${v[1]}`);
        }
      }
    }
  }
  return hits;
}

/**
 * Floors on the scan's reach, so a walk that silently drops a directory or most of its files cannot
 * pass. Set a little under today's counts (131 routers, 46 controllers).
 */
const MIN_SCANNED_FILES: Record<string, number> = { routers: 120, controllers: 40 };

describe('no-raw-event-viewer', () => {
  const files = SCAN_DIRS.flatMap((d) => walk(d)).map((file) => ({
    name: path.relative(SERVER_DIR, file),
    text: fs.readFileSync(file, 'utf-8'),
  }));

  it.each(Object.entries(MIN_SCANNED_FILES))('scans %s', (dir, min) => {
    expect(files.filter((f) => f.name.startsWith(dir + path.sep)).length).toBeGreaterThanOrEqual(
      min
    );
  });

  it('asks every event-decoration gate about eventViewerOf(ctx)', () => {
    expect(findViolations(files)).toEqual([]);
  });

  it('catches the session user passed as the viewer', () => {
    const text = [
      'getArticles({ eventDecorationViewer: ctx?.user });',
      'getImages({ eventDecorationViewer: user, other: 1 });',
      'getViewerEventDecorations({ ids, entity, viewer: ctx.user });',
      'getVisibleDecorationEvents(entity, ctx.user);',
      'getModels({ eventDecorationViewer: eventViewerOf(ctx) ?? ctx.user });',
      'const viewer = ctx.user; getEventDecorationsForEntity({ ids, entity, viewer });',
      'getImages({ eventDecorationViewer });',
      'getVisibleDecorationEvents(pick(a, b), ctx.user);',
      'equipCosmeticToEntity({ ...input, isModerator: ctx.user.isModerator });',
      'getVisibleDecorationEvents<Entity>(entity, ctx.user);',
    ].join('\n');
    expect(findViolations([{ name: 'fixture.ts', text }])).toEqual([
      'fixture.ts:1: eventDecorationViewer',
      'fixture.ts:2: eventDecorationViewer',
      'fixture.ts:5: eventDecorationViewer',
      'fixture.ts:7: eventDecorationViewer',
      'fixture.ts:3: getViewerEventDecorations viewer',
      'fixture.ts:4: getVisibleDecorationEvents viewer',
      'fixture.ts:6: getEventDecorationsForEntity viewer',
      'fixture.ts:8: getVisibleDecorationEvents viewer',
      'fixture.ts:10: getVisibleDecorationEvents viewer',
      'fixture.ts:9: equipCosmeticToEntity isModerator',
    ]);
  });

  it('catches the session user passed to an event-access or home-block gate', () => {
    const text = [
      'getViewerEventAccess({ event, viewer: ctx.user });',
      'filterViewableHomeBlocks(await getSystemHomeBlocks({ input }), ctx.user);',
      'getHomeBlocks({ ids, viewer: ctx.user });',
      'getNavBanners({ viewer: ctx.user });',
      'getHomeBlockById({ ...input, viewer: ctx.user });',
      'setHomeBlocksOrder({ input, viewer: ctx.user });',
      'getCollectionBlockAudience({ blockUserId, collectionId, viewer: ctx.user });',
      'markEventPointsWatched(input, ctx.user);',
      'getShopSectionsWithItems({ ...input, isModerator: ctx?.user?.isModerator });',
    ].join('\n');
    expect(findViolations([{ name: 'fixture.ts', text }])).toEqual([
      'fixture.ts:1: getViewerEventAccess viewer',
      'fixture.ts:2: filterViewableHomeBlocks viewer',
      'fixture.ts:3: getHomeBlocks viewer',
      'fixture.ts:4: getNavBanners viewer',
      'fixture.ts:5: getHomeBlockById viewer',
      'fixture.ts:6: setHomeBlocksOrder viewer',
      'fixture.ts:7: getCollectionBlockAudience viewer',
      'fixture.ts:8: markEventPointsWatched viewer',
      'fixture.ts:9: getShopSectionsWithItems isModerator',
    ]);
  });

  it('catches the session user passed to anything imported from the event service', () => {
    const text = [
      "import { getEventData, setShowcaseHat as setHat } from '~/server/services/event.service';",
      "import type { getTeamRoster } from '~/server/services/event.service';",
      'getTeamRoster({ viewer: ctx.user });',
      'getEventData({ ...input, viewer: ctx.user });',
      'setHat({ user: ctx.user, ...input });',
      'getEventData({ ...input, viewer: eventViewerOf(ctx) });',
      'setHat({ user: eventUserOf(ctx), ...input });',
      'donate({ userId: ctx.user.id });',
      'unrelated({ user: ctx.user });',
    ].join('\n');
    expect(findViolations([{ name: 'fixture.ts', text }])).toEqual([
      'fixture.ts:4: getEventData viewer',
      'fixture.ts:5: setHat user',
    ]);
  });

  it('sees a type-annotated assignment of the same local', () => {
    const text = [
      'const viewer = eventViewerOf(ctx);',
      'getViewerEventDecorations({ ids, entity, viewer });',
      'const other = () => { const viewer: EventViewer = ctx.user; return viewer; };',
    ].join('\n');
    expect(findViolations([{ name: 'fixture.ts', text }])).toEqual([
      'fixture.ts:2: getViewerEventDecorations viewer',
    ]);
  });

  it('does not take a parameter for a local bound to eventViewerOf(ctx)', () => {
    const text = [
      'const viewer = eventViewerOf(ctx);',
      'getViewerEventDecorations({ ids, entity, viewer });',
      'function load(viewer: EventViewer) {',
      '  return getViewerEventDecorations({ ids, entity, viewer });',
      '}',
      'const read = (eventViewer) => getVisibleDecorationEvents(entity, eventViewer);',
      'const eventViewer = eventViewerOf(ctx);',
    ].join('\n');
    expect(findViolations([{ name: 'fixture.ts', text }])).toEqual([
      'fixture.ts:2: getViewerEventDecorations viewer',
      'fixture.ts:4: getViewerEventDecorations viewer',
      'fixture.ts:6: getVisibleDecorationEvents viewer',
    ]);
  });

  it('accepts eventViewerOf(ctx) and locals bound to it', () => {
    const text = [
      'const eventViewer = eventViewerOf(ctx);',
      'getModels({ eventDecorationViewer: eventViewerOf(ctx) });',
      'getImages({ eventDecorationViewer: eventViewer, other: 1 });',
      'getEventDecorationsForEntity({ ids, entity, viewer: eventViewer });',
      'getVisibleDecorationEvents(entity, undefined);',
      'getViewerEventAccess({ event, viewer: undefined });',
      'withoutHiddenEventDecorations([{ cosmetic }], eventViewer);',
      'equipCosmeticToEntity({ ...input, isModerator: eventViewerOf(ctx).isModerator });',
    ].join('\n');
    expect(findViolations([{ name: 'fixture.ts', text }])).toEqual([]);
  });
});
