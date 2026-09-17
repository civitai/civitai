import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SourceMapGenerator } from 'source-map';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { applySourceMaps } from '~/server/utils/errorHandling';

/**
 * Covers the two bounds `applySourceMaps` puts on work driven by its `stack` argument.
 *
 * That argument reaches this function from `/api/application-error`, which is unauthenticated and
 * takes `stack` as free-form text, so every value below is something a caller can send.
 *
 * NOTHING HERE IS MOCKED. `process.cwd()` is pointed at a real temp directory holding a real build
 * tree, the maps are real maps built by `SourceMapGenerator`, and the resolver runs against them
 * through the real `SourceMapConsumer`. `fs.readFileSync` is only WRAPPED — the spy records each
 * path and calls straight through — because what these guards are about is which files get read,
 * and that is not observable from the return value. A stubbed `fs` would have let a guard pass by
 * agreeing with a fixture instead of with the filesystem.
 */

let tmpRoot: string;
let buildDir: string;
let chunkDir: string;
let outsideFile: string;
let readSpy: ReturnType<typeof vi.spyOn>;

/** Every path handed to `fs.readFileSync` since the last reset. */
let readPaths: string[] = [];

/** Writes a real chunk plus the real map it points at, and returns the chunk's absolute path. */
function writeChunk(name: string): string {
  const generator = new SourceMapGenerator({ file: name });
  generator.addMapping({
    generated: { line: 1, column: 10 },
    original: { line: 42, column: 4 },
    // The webpack spelling, so `normalizeSourcePath` has something real to normalise.
    source: 'webpack://_N_E/../src/components/Thing.tsx',
    name: 'renderThing',
  });

  const chunkPath = path.join(chunkDir, name);
  fs.writeFileSync(chunkPath, `(()=>{throw 0})()\n//# sourceMappingURL=${name}.map\n`);
  fs.writeFileSync(`${chunkPath}.map`, generator.toString());
  return chunkPath;
}

/** A frame in the shape a browser actually sends: an absolute `_next` URL, not a filesystem path. */
const frame = (fn: string, chunk: string, line = 1, column = 10) =>
  `    at ${fn} (https://civitai.com/_next/static/chunks/${chunk}:${line}:${column})`;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-applysourcemaps-'));
  buildDir = path.join(tmpRoot, '.next');
  chunkDir = path.join(buildDir, 'static', 'chunks');
  fs.mkdirSync(chunkDir, { recursive: true });

  // A real, readable file OUTSIDE the build directory. It has to exist, or "was not read" would be
  // true whether or not the guard is there — the assertion would hold for the wrong reason.
  fs.mkdirSync(path.join(tmpRoot, 'outside'), { recursive: true });
  outsideFile = path.join(tmpRoot, 'outside', 'not-a-build-artifact.txt');
  fs.writeFileSync(outsideFile, 'contents of a file the resolver has no business reading\n');

  vi.spyOn(process, 'cwd').mockReturnValue(tmpRoot);

  const realReadFileSync = fs.readFileSync;
  readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: never, ...rest: never[]) => {
    if (typeof p === 'string') readPaths.push(p);
    return (realReadFileSync as (...a: never[]) => unknown)(p, ...rest);
  }) as never);
});

afterEach(() => {
  readPaths = [];
});

afterAll(() => {
  readSpy?.mockRestore();
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('applySourceMaps — reads stay inside the build directory', () => {
  // 🔴 THE PATH GUARD. A frame's file is attacker-supplied text, and the `.next`-relative part is
  // taken from it with a regex, so `..` segments survive into the path the resolver opens. Without
  // a containment check the resolver reads whatever the frame names and scans it for a
  // `sourceMappingURL`.
  //
  // The traversal frame here is NOT shaped to make the branch easy: it sits in a stack alongside a
  // real chunk, it is spelled as a browser `_next` URL like every other frame, it names a file that
  // really exists, and it has a line and column so it survives the frame loop's own filters. It
  // reaches the resolver exactly as a real one would.
  it('does not read a file a frame points at outside the build directory', async () => {
    const chunk = writeChunk('guard-legit-a.js');
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'map')",
      frame('t', 'guard-legit-a.js'),
      frame('r', '../../../outside/not-a-build-artifact.txt'),
    ].join('\n');

    const result = await applySourceMaps(stack);

    // The guard itself.
    expect(readPaths).not.toContain(outsideFile);
    // Stated as the invariant rather than as one filename, so a different escape also fails here.
    expect(readPaths.filter((p) => !path.resolve(p).startsWith(buildDir + path.sep))).toEqual([]);

    // POSITIVE CONTROL. Without this the assertions above would also hold for a resolver that read
    // nothing at all — including one broken so badly it never ran. The legitimate frame in the same
    // stack must have been read and resolved, which is what proves the traversal frame was rejected
    // by the guard rather than by the loop never reaching it.
    expect(readPaths).toContain(chunk);
    expect(result).toContain('src/components/Thing.tsx:42:4');

    // A rejected frame is skipped, not dropped and not an error: it comes back as it went in.
    expect(result).toContain('../../../outside/not-a-build-artifact.txt');
    expect(result.split('\n')).toHaveLength(stack.split('\n').length);
  });

  // The second place a path is built from data rather than from code: having read a chunk, the
  // resolver follows the `sourceMappingURL` written inside it. That URL is only as trustworthy as
  // the chunk a frame selected, so it gets the same rule.
  it('does not follow a sourceMappingURL out of the build directory', async () => {
    const chunkPath = path.join(chunkDir, 'guard-escaping-url.js');
    fs.writeFileSync(
      chunkPath,
      `(()=>{throw 0})()\n//# sourceMappingURL=../../../outside/not-a-build-artifact.txt\n`
    );
    // Deliberately NO sibling `.map`, so the convention-based fallback finds nothing either and
    // the only path to that file would be the URL.
    const stack = ['Error: boom', frame('t', 'guard-escaping-url.js')].join('\n');

    const result = await applySourceMaps(stack);

    expect(readPaths).not.toContain(outsideFile);
    expect(readPaths.filter((p) => !path.resolve(p).startsWith(buildDir + path.sep))).toEqual([]);
    // POSITIVE CONTROL: the chunk itself WAS read, so the URL really was reached and rejected.
    expect(readPaths).toContain(chunkPath);
    // Unresolvable is fine — the frame comes back untouched.
    expect(result).toBe(stack);
  });

  it('rejects an absolute path smuggled through the relative part of a frame', async () => {
    // An absolute path straight after `.next/` makes the regex's capture group start with a slash,
    // so the captured "relative" path is absolute. Resolving it against the build dir yields that
    // absolute path unchanged — which is why the check is on the RESOLVED result, not on the text,
    // and why `path.resolve` is used rather than `path.join`.
    const stack = [
      'Error: boom',
      `    at f (/app/.next/${outsideFile}:1:10)`,
      frame('t', 'guard-legit-b.js'),
    ].join('\n');
    writeChunk('guard-legit-b.js');

    await applySourceMaps(stack);

    expect(readPaths).not.toContain(outsideFile);
    expect(readPaths.filter((p) => !path.resolve(p).startsWith(buildDir + path.sep))).toEqual([]);
  });
});

describe('applySourceMaps — the work one call can do is bounded', () => {
  /** Distinct `.js` chunk files read during the last call (maps excluded). */
  const distinctChunksRead = () => [...new Set(readPaths.filter((p) => p.endsWith('.js')))].length;

  const stackOf = (prefix: string, count: number) =>
    [
      'Error: boom',
      ...Array.from({ length: count }, (_, i) => {
        const name = `${prefix}-${i}.js`;
        writeChunk(name);
        return frame(`f${i}`, name);
      }),
    ].join('\n');

  // 🔴 THE BOUND. Each distinct frame file costs a read of the chunk, a read of its map and a
  // `SourceMapConsumer` build, all awaited on the request path. The number of distinct files in a
  // stack is set by whoever sends the stack, so without a cap the cost of one request is too.
  it('resolves at most a fixed number of distinct frame files, however many are sent', async () => {
    await applySourceMaps(stackOf('cap-small', 14));
    const small = distinctChunksRead();

    readPaths = [];
    await applySourceMaps(stackOf('cap-large', 40));
    const large = distinctChunksRead();

    // The relationship is the point: nearly tripling the frame count must not move the work.
    expect(large).toBe(small);
    // And the value, so a cap raised to something that no longer bounds anything fails here.
    expect(small).toBe(10);
  });

  it('passes frames beyond the cap through unresolved rather than dropping or throwing', async () => {
    const stack = stackOf('cap-degrade', 14);

    const result = await applySourceMaps(stack);

    // Nothing is lost: every line survives, and the ones past the cap are byte-identical.
    const before = stack.split('\n');
    const after = result.split('\n');
    expect(after).toHaveLength(before.length);
    expect(after.slice(11)).toEqual(before.slice(11));
    // The frames within the cap did resolve, so the cap is what stopped the rest.
    expect(result).toContain('src/components/Thing.tsx:42:4');
  });
});

describe('applySourceMaps — parsed maps are reused across calls', () => {
  // The cache used to be declared inside the function, so two reports naming the same chunk each
  // paid the full read and parse. Reports cluster on a few chunks, so that was the common case.
  it('does not re-read a chunk it has already parsed', async () => {
    writeChunk('reuse-a.js');
    const stack = ['Error: boom', frame('t', 'reuse-a.js')].join('\n');

    const first = await applySourceMaps(stack);
    const firstReads = [...readPaths];
    readPaths = [];
    const second = await applySourceMaps(stack);

    // First call does the work.
    expect(firstReads.some((p) => p.endsWith('reuse-a.js'))).toBe(true);
    expect(firstReads.some((p) => p.endsWith('reuse-a.js.map'))).toBe(true);
    // Second call does none of it.
    expect(readPaths).toEqual([]);
    // And still answers, from the cached consumer.
    expect(second).toBe(first);
    expect(second).toContain('src/components/Thing.tsx:42:4');
  });

  // 🔴 The cache is bounded, and that is the half worth pinning: each entry is a multi-megabyte
  // parsed map that lives as long as the process, so a cache that only ever grew would trade the
  // per-request cost this change removed for a permanent one. Kept last in the file because it
  // deliberately fills the cache.
  it('evicts, so the number of resident parsed maps cannot grow without limit', async () => {
    writeChunk('evict-target.js');
    const targetStack = ['Error: boom', frame('t', 'evict-target.js')].join('\n');

    await applySourceMaps(targetStack);

    // Enough distinct chunks to push the target out, whatever the cache already held: every one of
    // these is newer than the target, so the target is evicted before any of them.
    for (let i = 0; i < 8; i++) {
      writeChunk(`evict-filler-${i}.js`);
      await applySourceMaps(['Error: boom', frame('f', `evict-filler-${i}.js`)].join('\n'));
    }

    readPaths = [];
    const result = await applySourceMaps(targetStack);

    // Re-read is the observable of eviction — the previous test proved a resident entry is NOT
    // re-read, so this is the same instrument reporting the opposite state.
    expect(readPaths.some((p) => p.endsWith('evict-target.js'))).toBe(true);
    // Evicting must not break resolution: it is rebuilt and answers the same.
    expect(result).toContain('src/components/Thing.tsx:42:4');
  });
});
