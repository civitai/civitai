import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Convention guard: the viewer an event-decoration gate is asked about, in a router or controller,
 * is `eventViewerOf(ctx)` (or a local every assignment binds to it), never the session user; and
 * the moderator flag a placement passes is `eventViewerOf(ctx).isModerator`.
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
const FIELD_GATES = ['getEventDecorationsForEntity', 'getViewerEventDecorations'];
/** Gates taking the viewer as their second positional argument. */
const POSITIONAL_GATES = ['getVisibleDecorationEvents', 'withoutHiddenEventDecorations'];
/** Type arguments (`<T>`) may sit between a call's name and its `(`. */
const TYPE_ARGS = '\\s*(?:<[^()]*>)?\\s*';
const GATE_CALL = new RegExp(
  `\\b(${[...FIELD_GATES, ...POSITIONAL_GATES].join('|')})${TYPE_ARGS}\\(`,
  'g'
);
/** The placement gate takes the moderator flag rather than a viewer. */
const PLACEMENT_CALL = new RegExp(`\\bequipCosmeticToEntity${TYPE_ARGS}\\(`, 'g');
const VIEWER_FIELD = /[{,]\s*eventDecorationViewer\b\s*(:\s*)?/g;
const EVENT_VIEWER_OF = /^eventViewerOf\(\s*ctx\s*\)/;

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
  const assignments = [...source.matchAll(new RegExp(`\\b${id}\\s*=(?!=)\\s*`, 'g'))];
  return (
    assignments.length > 0 &&
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
          if (!isEventViewer(value, source)) hits.push(`${where(m.index)}: ${m[1]} viewer`);
        }
      } else {
        const second = topLevelArgs(args)[1] ?? '';
        if (second && second !== 'undefined' && !isEventViewer(second, source))
          hits.push(`${where(m.index)}: ${m[1]} viewer`);
      }
    }
    for (const m of source.matchAll(PLACEMENT_CALL)) {
      const args = callArgs(source, m.index + m[0].length - 1);
      for (const v of args.matchAll(/[{,]\s*isModerator\b\s*(:\s*)?/g)) {
        const value = v[1] ? valueAt(args, v.index + v[0].length) : 'isModerator';
        if (!isEventViewer(value, source, '.isModerator'))
          hits.push(`${where(m.index)}: equipCosmeticToEntity isModerator`);
      }
    }
  }
  return hits;
}

/** A floor on the scan's reach, so a walk that silently stops finding files cannot pass. */
const MIN_SCANNED_FILES = 80;

describe('no-raw-event-viewer', () => {
  const files = SCAN_DIRS.flatMap((d) => walk(d)).map((file) => ({
    name: path.relative(SERVER_DIR, file),
    text: fs.readFileSync(file, 'utf-8'),
  }));

  it('scans the routers and controllers', () => {
    expect(files.length).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);
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

  it('accepts eventViewerOf(ctx) and locals bound to it', () => {
    const text = [
      'const eventViewer = eventViewerOf(ctx);',
      'getModels({ eventDecorationViewer: eventViewerOf(ctx) });',
      'getImages({ eventDecorationViewer: eventViewer, other: 1 });',
      'getEventDecorationsForEntity({ ids, entity, viewer: eventViewer });',
      'getVisibleDecorationEvents(entity, undefined);',
      'withoutHiddenEventDecorations([{ cosmetic }], eventViewer);',
      'equipCosmeticToEntity({ ...input, isModerator: eventViewerOf(ctx).isModerator });',
    ].join('\n');
    expect(findViolations([{ name: 'fixture.ts', text }])).toEqual([]);
  });
});
