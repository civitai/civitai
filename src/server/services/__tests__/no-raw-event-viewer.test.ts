import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Convention guard: the viewer an event-decoration gate is asked about, in a router or controller,
 * is `eventViewerOf(ctx)` (or a local `eventViewer` holding it), never the session user.
 *
 * Before an event launches only its flag audience sees its hats, and a moderator is in every flag
 * audience. `eventViewerOf` counts that only for a session or a full-access personal key, the same
 * rule moderatorProcedure applies. Passing `ctx.user` straight through skips it.
 *
 * If this fails: pass `eventViewerOf(ctx)` from ~/server/events/event-viewer.
 */

const SERVER_DIR = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['routers', 'controllers'].map((d) => path.join(SERVER_DIR, d));

const ALLOWED_VALUE = /^(eventViewer\b|eventViewerOf\()/;
const VIEWER_FIELD = /\beventDecorationViewer\s*:\s*/g;
const GATE_CALL =
  /\b(getEventDecorationsForEntity|getViewerEventDecorations|getVisibleDecorationEvents)\s*\(/g;

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

function lineOf(source: string, index: number) {
  return source.slice(0, index).split('\n').length;
}

function findViolations(files: { name: string; text: string }[]) {
  const hits: string[] = [];
  for (const { name, text } of files) {
    const source = stripComments(text);
    const where = (index: number) => `${name}:${lineOf(source, index)}`;

    for (const m of source.matchAll(VIEWER_FIELD)) {
      const at = m.index + m[0].length;
      if (!ALLOWED_VALUE.test(source.slice(at)))
        hits.push(`${where(m.index)}: eventDecorationViewer`);
    }
    for (const m of source.matchAll(GATE_CALL)) {
      const args = callArgs(source, m.index + m[0].length - 1);
      for (const v of args.matchAll(/\bviewer\s*:\s*/g)) {
        if (!ALLOWED_VALUE.test(args.slice(v.index + v[0].length)))
          hits.push(`${where(m.index)}: ${m[1]} viewer`);
      }
      // A gate called with a bare positional viewer (getVisibleDecorationEvents(entity, viewer)).
      if (m[1] === 'getVisibleDecorationEvents') {
        const second = args.split(',')[1]?.trim() ?? '';
        if (second && second !== 'undefined' && !ALLOWED_VALUE.test(second))
          hits.push(`${where(m.index)}: ${m[1]} viewer`);
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
      'getModels({ eventDecorationViewer: eventViewerOf(ctx) });',
      'getEventDecorationsForEntity({ ids, entity, viewer: eventViewer });',
      'getVisibleDecorationEvents(entity, undefined);',
    ].join('\n');
    expect(findViolations([{ name: 'fixture.ts', text }])).toEqual([
      'fixture.ts:1: eventDecorationViewer',
      'fixture.ts:2: eventDecorationViewer',
      'fixture.ts:3: getViewerEventDecorations viewer',
      'fixture.ts:4: getVisibleDecorationEvents viewer',
    ]);
  });
});
