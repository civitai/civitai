import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SourceMapConsumer, SourceMapGenerator } from 'source-map';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { applySourceMaps } from '~/server/utils/errorHandling';

/**
 * Covers what `applySourceMaps` reads, how much of it, and how it reuses what it parsed: the
 * containment rules on every path it opens, the bound on work driven by its `stack` argument and
 * which frames that bound is spent on, the parsed-map cache, and the one `source-map` behaviour
 * the cache's eviction depends on.
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
let outsideMapFile: string;
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

/**
 * A source map identical in shape to the ones `writeChunk` emits, but naming a source nobody under
 * the build directory ever maps to. Written OUTSIDE `.next`, it is what the two symlink-escape
 * tests below point at: because it is a real, valid, resolvable map, a resolver that reads it
 * answers with `LEAKED_SOURCE` instead of failing — so those tests can assert on the ANSWER and not
 * only on the absence of a read.
 */
const LEAKED_SOURCE = 'src/leaked/OutsideTheBuildDir.tsx';

function leakedMapContent(): string {
  const generator = new SourceMapGenerator({ file: 'leaked.js' });
  generator.addMapping({
    generated: { line: 1, column: 10 },
    original: { line: 7, column: 3 },
    source: `webpack://_N_E/../${LEAKED_SOURCE}`,
    name: 'leakedSymbol',
  });
  return generator.toString();
}

/** A frame in the shape a browser actually sends: an absolute `_next` URL, not a filesystem path. */
const frame = (fn: string, chunk: string, line = 1, column = 10) =>
  `    at ${fn} (https://civitai.com/_next/static/chunks/${chunk}:${line}:${column})`;

/** Writes `count` real chunks and returns a stack naming all of them. */
const stackOf = (prefix: string, count: number) =>
  [
    'Error: boom',
    ...Array.from({ length: count }, (_, i) => {
      const name = `${prefix}-${i}.js`;
      writeChunk(name);
      return frame(`f${i}`, name);
    }),
  ].join('\n');

/** Distinct `.js` chunk files read since the last reset (maps excluded). */
const distinctChunksRead = () => [...new Set(readPaths.filter((p) => p.endsWith('.js')))].length;

beforeAll(() => {
  // `realpathSync` so the build directory the resolver is pointed at is already the path the
  // filesystem resolves to. The resolver checks containment against real paths, and on platforms
  // where the temp directory is itself a symlink (macOS `/tmp` -> `/private/tmp`) an unresolved
  // root would make every legitimate chunk look like an escape and every assertion below hold for
  // the wrong reason.
  tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'civitai-applysourcemaps-')));
  buildDir = path.join(tmpRoot, '.next');
  chunkDir = path.join(buildDir, 'static', 'chunks');
  fs.mkdirSync(chunkDir, { recursive: true });

  // A real, readable file OUTSIDE the build directory. It has to exist, or "was not read" would be
  // true whether or not the guard is there — the assertion would hold for the wrong reason.
  fs.mkdirSync(path.join(tmpRoot, 'outside'), { recursive: true });
  outsideFile = path.join(tmpRoot, 'outside', 'not-a-build-artifact.txt');
  fs.writeFileSync(outsideFile, 'contents of a file the resolver has no business reading\n');
  outsideMapFile = path.join(tmpRoot, 'outside', 'leaked.js.map');
  fs.writeFileSync(outsideMapFile, leakedMapContent());

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
    const legit = writeChunk('guard-legit-b.js');

    const result = await applySourceMaps(stack);

    expect(readPaths).not.toContain(outsideFile);
    expect(readPaths.filter((p) => !path.resolve(p).startsWith(buildDir + path.sep))).toEqual([]);

    // POSITIVE CONTROL. The two assertions above are both NEGATIVE: they hold just as well for a
    // resolver that read nothing at all, including one broken so badly it never ran — and that is
    // not hypothetical, it is measured. When this file held seven tests and this one had no
    // control, mutating `applySourceMaps` to `return stack` as its first statement turned six of
    // the seven red and left THIS ONE GREEN — it was asserting nothing. The legitimate chunk in
    // the same stack must have been read AND resolved, which is what makes this a claim about the
    // guard rejecting the smuggled path rather than about nothing having run.
    expect(readPaths).toContain(legit);
    expect(result).toContain('src/components/Thing.tsx:42:4');
  });

  // 🔴 CONTAINMENT IS ENFORCED ON THE PATH THE FILESYSTEM OPENS, NOT ON ITS SPELLING. `path.relative`
  // compares text; `readFileSync` follows symlinks. A symlink under the build directory is
  // therefore lexically contained and points anywhere, so the check has to run on the real path.
  // Nothing puts a symlink under `.next` in the deployed image today — this pins the property the
  // comment on `nextBuildDir` states, so that it stays true of the reads and not just of the text.
  it('does not follow a symlink out of the build directory', async () => {
    const linkPath = path.join(chunkDir, 'guard-symlink.js');
    fs.symlinkSync(outsideFile, linkPath);
    // Not shaped for the branch: the frame is spelled as an ordinary browser `_next` URL, the file
    // it names really resolves to a readable file, and it sits beside a real chunk in one stack.
    const legit = writeChunk('guard-legit-symlink.js');
    const stack = [
      'Error: boom',
      frame('t', 'guard-symlink.js'),
      frame('u', 'guard-legit-symlink.js'),
    ].join('\n');

    const result = await applySourceMaps(stack);

    expect(readPaths).not.toContain(outsideFile);
    expect(readPaths).not.toContain(linkPath);
    expect(readPaths.filter((p) => !path.resolve(p).startsWith(buildDir + path.sep))).toEqual([]);

    // POSITIVE CONTROL: the legitimate frame in the same stack was read and resolved, so the
    // symlink frame was rejected by the guard and not by the loop never reaching it.
    expect(readPaths).toContain(legit);
    expect(result).toContain('src/components/Thing.tsx:42:4');

    // Rejected, not dropped and not an error.
    expect(result).toContain('guard-symlink.js');
    expect(result.split('\n')).toHaveLength(stack.split('\n').length);
  });

  // 🔴 THE SAME GUARD, AT THE SECOND OF ITS THREE SITES. The symlink test above enters through the
  // CHUNK read; the containment check on the `sourceMappingURL` follow is a different call, and
  // reverting just that one to the lexical `isInsideDir(...) && fs.existsSync(...)` it replaced was
  // SURVIVED by every test in this file. Nothing above can see it: the existing
  // sourceMappingURL test escapes with `..` segments, which the lexical check rejects on its own,
  // so it never asks whether the path is resolved.
  //
  // The escape here is a symlink, which is lexically contained and `existsSync`-true, so only the
  // real-path resolution can reject it. It is also not shaped to make the branch easy: the chunk is
  // an ordinary chunk under `.next`, the URL is a plain relative filename of the kind webpack and
  // Turbopack both emit, and the target is a VALID source map — so a resolver that follows it
  // succeeds and says so, rather than failing for some unrelated reason.
  it('does not follow a symlinked sourceMappingURL out of the build directory', async () => {
    const chunkPath = path.join(chunkDir, 'guard-url-symlink.js');
    const linkPath = path.join(chunkDir, 'guard-url-symlink-target.map');
    fs.symlinkSync(outsideMapFile, linkPath);
    // The URL names the LINK, and there is deliberately no `<chunk>.js.map` sibling, so the
    // convention fallback cannot reach the same file — this test can only be answered through the
    // sourceMappingURL path.
    fs.writeFileSync(
      chunkPath,
      `(()=>{throw 0})()\n//# sourceMappingURL=guard-url-symlink-target.map\n`
    );
    const legit = writeChunk('guard-legit-url-symlink.js');
    const stack = [
      'Error: boom',
      frame('t', 'guard-url-symlink.js'),
      frame('u', 'guard-legit-url-symlink.js'),
    ].join('\n');

    const result = await applySourceMaps(stack);

    // The guard: neither the link nor what it resolves to was opened.
    expect(readPaths).not.toContain(outsideMapFile);
    expect(readPaths).not.toContain(linkPath);
    expect(readPaths.filter((p) => !path.resolve(p).startsWith(buildDir + path.sep))).toEqual([]);
    // And the answer it would have produced is absent, which is the assertion that does not also
    // hold for a resolver that simply read nothing.
    expect(result).not.toContain(LEAKED_SOURCE);

    // POSITIVE CONTROL, in two halves. The chunk itself WAS read, so the URL really was reached
    // and rejected rather than never looked at; and the legitimate frame beside it resolved, so
    // the loop ran.
    expect(readPaths).toContain(chunkPath);
    expect(readPaths).toContain(legit);
    expect(result).toContain('src/components/Thing.tsx:42:4');

    // Rejected, not dropped and not an error.
    expect(result).toContain('guard-url-symlink.js');
    expect(result.split('\n')).toHaveLength(stack.split('\n').length);
  });

  // 🔴 THE SAME GUARD, AT THE THIRD SITE: the webpack-convention `<chunk>.map` sibling. Reverting
  // only this one to `const fallbackPath = `${chunkPath}.map`` plus an `existsSync` was likewise
  // SURVIVED by every test in this file before this one existed — a sibling is derived from a
  // contained path, so the lexical check it replaced was always true there and the only thing the
  // guard adds is the symlink case.
  //
  // The chunk carries NO `sourceMappingURL`, which is the real webpack shape and also what keeps
  // this test attributable: the previous site cannot answer it.
  it('does not follow a symlinked <chunk>.map sibling out of the build directory', async () => {
    const chunkPath = path.join(chunkDir, 'guard-fallback-symlink.js');
    fs.writeFileSync(chunkPath, `(()=>{throw 0})()\n`);
    const linkPath = `${chunkPath}.map`;
    fs.symlinkSync(outsideMapFile, linkPath);
    const legit = writeChunk('guard-legit-fallback-symlink.js');
    const stack = [
      'Error: boom',
      frame('t', 'guard-fallback-symlink.js'),
      frame('u', 'guard-legit-fallback-symlink.js'),
    ].join('\n');

    const result = await applySourceMaps(stack);

    expect(readPaths).not.toContain(outsideMapFile);
    expect(readPaths).not.toContain(linkPath);
    expect(readPaths.filter((p) => !path.resolve(p).startsWith(buildDir + path.sep))).toEqual([]);
    expect(result).not.toContain(LEAKED_SOURCE);

    // POSITIVE CONTROL: the chunk was read — so the fallback really was reached, with nothing in
    // the chunk to satisfy the sourceMappingURL branch first — and the legitimate frame resolved.
    expect(readPaths).toContain(chunkPath);
    expect(readPaths).toContain(legit);
    expect(result).toContain('src/components/Thing.tsx:42:4');

    expect(result).toContain('guard-fallback-symlink.js');
    expect(result.split('\n')).toHaveLength(stack.split('\n').length);
  });

  // INVARIANT GUARD, not regression coverage — labelled so nobody counts it as more than it is.
  // Resolving the real path means asking the filesystem about a path that need not exist, and
  // `realpathSync` THROWS on a missing file where the `path.resolve` it replaced could not. A
  // chunk from an older build is the ordinary case, so that must stay a skipped frame. No
  // single-point mutation was found that this test uniquely kills: `containedRealPath` catches,
  // and the per-file `try`/`catch` in `applySourceMaps` catches again, so removing either one
  // leaves the behaviour unchanged. It dies to the whole-file inert-resolver control and nothing
  // narrower. Kept because the property is the one the switch to `realpathSync` put at risk.
  it('skips a frame naming a chunk that is not on disk, and still resolves the rest', async () => {
    const legit = writeChunk('guard-legit-missing.js');
    const stack = [
      'Error: boom',
      frame('t', 'no-such-chunk-from-an-older-build.js'),
      frame('u', 'guard-legit-missing.js'),
    ].join('\n');

    const result = await applySourceMaps(stack);

    expect(readPaths).toContain(legit);
    expect(result).toContain('src/components/Thing.tsx:42:4');
    expect(result).toContain('no-such-chunk-from-an-older-build.js');
    expect(result.split('\n')).toHaveLength(stack.split('\n').length);
  });
});

describe('applySourceMaps — the work one call can do is bounded', () => {
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

  // 🔴 THE CAP IS SPENT ON FRAMES THAT CAN BE RESOLVED. A frame whose file is not under the build
  // directory — a browser extension, an analytics or payment script, a captcha widget — can never
  // produce a read, so letting it take a cap slot buys nothing and costs a real app chunk further
  // down its resolution. That is an ordinary shape for the stacks that actually reach the
  // resolver — a browser caller's own error stack, where injected third-party code sits on top.
  //
  // Reachability: the foreign frames are ten DISTINCT real third-party URLs in the spelling a
  // browser sends, and the app chunk is the eleventh distinct file, one past the cap. Nothing here
  // is shaped to make a branch trivially true.
  it('does not let unresolvable frames consume the cap', async () => {
    const foreign = [
      'chrome-extension://hbkpclpemjeibhioopcebchdmohaieln/inject.js',
      'moz-extension://5b2fbd0f-93df-4a3c-9f03-1b8a36cfd7ac/content.js',
      'https://js.stripe.com/v3/controller.js',
      'https://challenges.cloudflare.com/turnstile/v0/api.js',
      'https://www.googletagmanager.com/gtag/js',
      'https://static.cloudflareinsights.com/beacon.min.js',
      'https://connect.facebook.net/en_US/fbevents.js',
      'https://cdn.segment.com/analytics.js/v1/analytics.min.js',
      'https://www.clarity.ms/tag/clarity.js',
      'https://plausible.io/js/script.js',
    ];
    expect(new Set(foreign).size).toBe(10);

    // CONTROL, run first and on its own chunk so nothing is cached for the case below: the same
    // app frame resolves when it is NOT buried, which is what makes the failure below attributable
    // to the foreign frames rather than to the chunk or the fixture.
    const controlChunk = writeChunk('cap-priority-control.js');
    const controlResult = await applySourceMaps(
      ['Error: boom', frame('app', 'cap-priority-control.js')].join('\n')
    );
    expect(readPaths).toContain(controlChunk);
    expect(controlResult).toContain('src/components/Thing.tsx:42:4');

    readPaths = [];
    const buriedChunk = writeChunk('cap-priority-buried.js');
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'call')",
      ...foreign.map((url, i) => `    at t${i} (${url}:1:${100 + i})`),
      frame('renderThing', 'cap-priority-buried.js'),
    ].join('\n');

    const result = await applySourceMaps(stack);

    expect(readPaths).toContain(buriedChunk);
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

  // 🔴 THE CACHE MUST HOLD A WHOLE CALL'S WORKING SET. One call may resolve up to the cap's worth
  // of distinct chunks, so a cache smaller than the cap is worse than no cache: the tail of a
  // single call evicts its own head, and the next report naming the same chunks re-reads every one
  // of them at a 0% hit rate while still paying the memory. Measured before the fix, with the cap
  // at 10 over a cache of 8, the identical ten-chunk stack sent twice re-read 10 of 10.
  //
  // This is the behavioural half of the `MAX_CACHED_SOURCE_MAPS = MAX_RESOLVED_FRAME_FILES`
  // derivation: if either number is later changed so the cache is below the cap, this goes red.
  // The width is the cap's own value, which the bound test above pins at 10.
  it('does not re-read any chunk of a repeated full-width stack', async () => {
    const stack = stackOf('reuse-width', 10);

    const first = await applySourceMaps(stack);
    // Positive control on the instrument: the first call really did read all ten, so an empty
    // second reading means reuse rather than a spy that stopped recording.
    expect(distinctChunksRead()).toBe(10);

    readPaths = [];
    const second = await applySourceMaps(stack);

    expect(readPaths).toEqual([]);
    expect(second).toBe(first);
    expect(second).toContain('src/components/Thing.tsx:42:4');
  });

  // 🔴 The cache is bounded, and that is the half worth pinning: each entry is a parsed map that
  // lives as long as the process, so a cache that only ever grew would trade the per-request cost
  // this change removed for a permanent one. Kept last in its describe because it deliberately
  // fills the cache; the describe after this one re-warms whatever it needs.
  it('evicts, so the number of resident parsed maps cannot grow without limit', async () => {
    writeChunk('evict-target.js');
    const targetStack = ['Error: boom', frame('t', 'evict-target.js')].join('\n');

    await applySourceMaps(targetStack);

    // Enough distinct chunks to push the target out, whatever the cache already held: every one of
    // these is newer than the target, so the target is evicted before any of them. Deliberately
    // OVERSHOOTS the bound rather than sitting on it — a filler count equal to the cache size
    // leaves the target exactly on the eviction boundary, where an off-by-one in either direction
    // decides the outcome and the test stops being about eviction at all.
    for (let i = 0; i < 13; i++) {
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

describe('applySourceMaps — eviction is safe while a call still holds the consumer', () => {
  // Eviction takes an entry out of the cache while another in-flight call may still be holding it:
  // `applySourceMaps` awaits each `new SourceMapConsumer(...)`, so two concurrent calls interleave
  // and one fills the cache behind the other's back. Both must still come back fully resolved.
  //
  // 🔴 REACHING THE HAZARD TAKES MORE THAN TWO CONCURRENT CALLS, and the obvious construction
  // does not reach it — measured. `SourceMapConsumer` parses its mappings LAZILY, and
  // `applySourceMaps` builds every consumer in its first loop but only asks for a position in its
  // second, so a consumer evicted during the first loop has never parsed and there is nothing yet
  // to free. Two calls each naming ten fresh chunks therefore evict ten consumers and touch
  // nothing that matters.
  //
  // The reachable shape needs a consumer that has already PARSED — one an earlier call resolved a
  // frame with — to be evicted while a later call is holding it. So: warm one, have call A open on
  // a cache HIT for it and hold it for the rest of the call, and have A and B insert 19 more
  // between them, which over a cache of 10 guarantees the warmed entry is evicted before A reaches
  // its frame loop.
  it('resolves a call still holding a consumer that a concurrent call evicted', async () => {
    writeChunk('hold-shared.js');
    const sharedStack = ['Error: boom', frame('s', 'hold-shared.js')].join('\n');
    const warm = await applySourceMaps(sharedStack);
    // Positive control: the warm call really did resolve through that consumer, which is what
    // leaves it parsed. Without this the setup could silently degrade to the no-op case above.
    expect(warm).toContain('src/components/Thing.tsx:42:4');

    const stackA = [sharedStack, ...stackOf('hold-a', 9).split('\n').slice(1)].join('\n');
    const stackB = stackOf('hold-b', 10);

    readPaths = [];
    const [resultA, resultB] = await Promise.all([
      applySourceMaps(stackA),
      applySourceMaps(stackB),
    ]);
    const readsDuringPair = [...readPaths];

    const resolvedLines = (s: string) =>
      s.split('\n').filter((l) => l.includes('src/components/Thing.tsx:42:4'));
    // Every frame of both stacks, including the one A held across the eviction.
    expect(resolvedLines(resultA)).toHaveLength(10);
    expect(resolvedLines(resultB)).toHaveLength(10);

    // 🔴 ASSERT THE HAZARD WAS REACHED, not just that the results came back right. Both halves are
    // decided by the code, not by scheduling: the shared entry is a cache HIT, and a hit takes no
    // `await`, so A borrows it synchronously before `Promise.all` even starts B.
    //
    // (a) A HELD it: nothing re-read the shared chunk during the pair, so A resolved its first
    //     frame through the consumer it borrowed at the top of the call.
    expect(readsDuringPair.filter((p) => p.endsWith('hold-shared.js'))).toEqual([]);
    // (b) It was EVICTED underneath A: 19 insertions over a cache of 10 put it out for certain, and
    //     the observable of that is a later call having to read it again. Without this the test
    //     would pass just as well on a cache large enough that no eviction ever happened — which is
    //     exactly the "green without reaching the hazard" case.
    readPaths = [];
    const after = await applySourceMaps(sharedStack);
    expect(readPaths.some((p) => p.endsWith('hold-shared.js'))).toBe(true);
    expect(after).toContain('src/components/Thing.tsx:42:4');
  });

  // 🔴 DEPENDENCY-BEHAVIOUR GUARD, not a test of this repo's code — it calls `source-map` directly
  // and deliberately does NOT go through `applySourceMaps`. It is the one test in this file that
  // survives the whole-file inert-resolver control for that reason.
  //
  // It pins the `destroy()` semantics the cache's bookkeeping is reasoned about in
  // `errorHandling.ts`: `source-map@0.7.6` frees the mappings and zeroes `_mappingsPtr`, and
  // `originalPositionFor` goes through `_getMappingsPtr()`, which RE-PARSES when the pointer is
  // zero. Hence the two properties the refcounting depends on — a destroyed consumer still answers
  // CORRECTLY (so the failure mode of getting this wrong is a leak, never a wrong source location),
  // and a second `destroy()` is a no-op (so retiring an entry and then releasing it is safe).
  //
  // 🔴 AND IT IS WHY `refs`/`evicted` EXIST RATHER THAN PLAIN LRU: that re-parse allocates a fresh
  // copy of the mappings into the process-wide wasm heap, and by then the consumer has left the
  // cache, so nothing will ever free it. The size of that is measured by the last test in this
  // file; this one pins the dependency behaviour that makes the reasoning valid.
  //
  // If a `source-map` upgrade makes a destroyed consumer return a wrong location, throw, or crash
  // on a second `destroy()`, this test goes red — and that is the signal that the eviction in
  // `errorHandling.ts` needs rethinking, not that this test needs updating.
  it('source-map: a destroyed consumer still resolves, and a second destroy is a no-op', async () => {
    const generator = new SourceMapGenerator({ file: 'destroy-probe.js' });
    generator.addMapping({
      generated: { line: 1, column: 10 },
      original: { line: 42, column: 4 },
      source: 'webpack://_N_E/../src/components/Thing.tsx',
      name: 'renderThing',
    });
    const consumer = await new SourceMapConsumer(generator.toString());

    try {
      const before = consumer.originalPositionFor({ line: 1, column: 10 });
      // Positive control: the mapping is real to begin with, so "unchanged after destroy" is not
      // two identical nulls agreeing with each other.
      expect(before.line).toBe(42);
      expect(before.column).toBe(4);
      expect(before.name).toBe('renderThing');

      consumer.destroy();
      expect(consumer.originalPositionFor({ line: 1, column: 10 })).toEqual(before);

      consumer.destroy();
      expect(consumer.originalPositionFor({ line: 1, column: 10 })).toEqual(before);
    } finally {
      consumer.destroy();
    }
  });
});

/**
 * 🔴 THE COST OF GETTING EVICTION-WHILE-HELD WRONG IS MEMORY, AND NOTHING ABOVE CAN SEE IT.
 *
 * Every test above asserts on a resolved stack, and the resolved stack is IDENTICAL either way:
 * `destroy()` on a consumer another call is holding is harmless to the ANSWER, because the holder's
 * next `originalPositionFor` re-parses. What the re-parse costs is a second allocation of the
 * mappings in the process-wide wasm heap that nothing will ever free — the consumer has already
 * left the cache. `WebAssembly.Memory` never shrinks and JS GC cannot reclaim a Rust-side
 * allocation, so it is permanent, and the cache being sized for ONE call's working set
 * (`MAX_CACHED_SOURCE_MAPS === MAX_RESOLVED_FRAME_FILES`) means concurrent calls evict each other's
 * live consumers as a matter of course rather than as a rare interleaving.
 *
 * So this file needed an instrument that reads memory, not text. It is deliberately the LAST
 * describe: it fills the cache and writes a large fixture set.
 */
describe('applySourceMaps — a held consumer that gets evicted is still freed', () => {
  /**
   * Maps big enough that one parse is worth megabytes rather than kilobytes — a real chunk's map
   * runs to several MB, and a fixture with a handful of mappings would make a genuine leak too
   * small to separate from allocator noise.
   */
  const FIXTURE_MAPPINGS = 20_000;
  /** Rounds run before measuring, to let the steady-state working set finish allocating. */
  const WARMUP_ROUNDS = 3;
  /** Rounds the assertion is made over. */
  const MEASURED_ROUNDS = 4;
  /**
   * Ceiling on wasm-heap growth across the measured rounds, in MiB.
   *
   * Chosen with headroom in both directions from a measurement on this fixture, not from taste.
   * With the bookkeeping in place the heap plateaus and the measured growth is 0.00 MiB, repeatably
   * — so any non-zero budget is slack. With it removed the leak is ~23.7 MiB PER ROUND, so a budget
   * below one round's worth cannot be walked by a partially-broken implementation either. 12 sits
   * between the two with roughly half a round of margin on the failing side and a whole budget of
   * margin on the passing side.
   */
  const GROWTH_BUDGET_MIB = 12;

  /** A chunk whose map is large enough for its parse to be visible in the wasm heap. */
  function writeBigChunk(name: string): string {
    const generator = new SourceMapGenerator({ file: name });
    generator.addMapping({
      generated: { line: 1, column: 10 },
      original: { line: 42, column: 4 },
      source: 'webpack://_N_E/../src/components/Thing.tsx',
      name: 'renderThing',
    });
    for (let i = 0; i < FIXTURE_MAPPINGS; i++) {
      generator.addMapping({
        generated: { line: 2 + i, column: (i * 7) % 90 },
        original: { line: 1 + (i % 5000), column: i % 80 },
        source: `webpack://_N_E/../src/gen/File${i % 64}.tsx`,
        name: `sym${i % 128}`,
      });
    }
    const chunkPath = path.join(chunkDir, name);
    fs.writeFileSync(chunkPath, `(()=>{throw 0})()\n//# sourceMappingURL=${name}.map\n`);
    fs.writeFileSync(`${chunkPath}.map`, generator.toString());
    return chunkPath;
  }

  const bigStackOf = (prefix: string, count: number) =>
    [
      'Error: boom',
      ...Array.from({ length: count }, (_, i) => {
        const name = `${prefix}-${i}.js`;
        writeBigChunk(name);
        return frame(`f${i}`, name);
      }),
    ].join('\n');

  /**
   * The wasm linear memory `source-map` allocates mappings out of.
   *
   * `lib/wasm.js` caches ONE `WebAssembly.Instance` for the whole process, so the memory reached
   * through any consumer is the same heap every consumer in this process uses — which is exactly
   * why a leak here is process-wide rather than per-consumer. Read through `_wasm` because the
   * library exposes no public handle; the alternative instruments are worse, not better:
   * `process.memoryUsage()` is GC-timing-dependent and would make this test flaky, and this
   * `byteLength` is a plain counter that only ever moves when the allocator has to grow.
   */
  async function wasmHeap(): Promise<WebAssembly.Memory> {
    const generator = new SourceMapGenerator({ file: 'heap-probe.js' });
    generator.addMapping({
      generated: { line: 1, column: 1 },
      original: { line: 1, column: 1 },
      source: 'probe.ts',
    });
    const probe = await new SourceMapConsumer(generator.toString());
    const memory = (probe as unknown as { _wasm: { exports: { memory: WebAssembly.Memory } } })
      ._wasm.exports.memory;
    probe.destroy();
    return memory;
  }

  // 🔴 THE SHAPE THAT REACHES THE LEAK, which is the same one the correctness test above uses: a
  // warmed, already-PARSED consumer, borrowed by call A on a cache hit, evicted underneath A by the
  // 19 fresh chunks A and B insert between them, and then used by A's frame loop. Each round leaks
  // once for the shared chunk and once for every fresh consumer that gets evicted while its own
  // builder is still in flight.
  it('holding a consumer across its eviction does not grow the wasm heap without bound', async () => {
    const memory = await wasmHeap();
    const heapMiB = () => memory.buffer.byteLength / (1024 * 1024);

    writeBigChunk('leak-shared.js');
    const sharedStack = ['Error: boom', frame('s', 'leak-shared.js')].join('\n');
    const warm = await applySourceMaps(sharedStack);
    // Positive control on the fixture: the shared consumer really parsed, so it has mappings to
    // leak. Without this the whole test could pass on a setup that never allocated anything.
    expect(warm).toContain('src/components/Thing.tsx:42:4');

    const round = async (tag: string) => {
      const stackA = [sharedStack, ...bigStackOf(`${tag}-a`, 9).split('\n').slice(1)].join('\n');
      const stackB = bigStackOf(`${tag}-b`, 10);
      const [resultA, resultB] = await Promise.all([
        applySourceMaps(stackA),
        applySourceMaps(stackB),
      ]);
      const resolved = (s: string) =>
        s.split('\n').filter((l) => l.includes('src/components/Thing.tsx:42:4')).length;
      return resolved(resultA) + resolved(resultB);
    };

    for (let i = 0; i < WARMUP_ROUNDS; i++) {
      // Asserted every round, not just at the end: a round that silently stopped resolving would
      // stop allocating too, and this test would then pass by doing nothing.
      expect(await round(`leak-warm${i}`)).toBe(20);
    }

    const before = heapMiB();
    // POSITIVE CONTROL ON THE INSTRUMENT. `byteLength` must be something this workload can move at
    // all, or "it did not grow" is a claim about a counter wired to nothing. The warm-up rounds
    // above allocate a full working set of large parsed maps from a heap that starts at a few MiB,
    // so the counter has demonstrably moved by the time it is read here.
    expect(before).toBeGreaterThan(20);

    for (let i = 0; i < MEASURED_ROUNDS; i++) {
      expect(await round(`leak-meas${i}`)).toBe(20);
    }
    const growthMiB = heapMiB() - before;

    expect(
      growthMiB,
      `wasm heap grew ${growthMiB.toFixed(2)} MiB over ${MEASURED_ROUNDS} rounds of ` +
        `evict-while-held (budget ${GROWTH_BUDGET_MIB} MiB). A consumer evicted while an in-flight ` +
        `call still holds it must be freed when that call releases it; if it is destroyed at ` +
        `eviction instead, the holder re-parses its mappings into the wasm heap and nothing ever ` +
        `frees them.`
    ).toBeLessThan(GROWTH_BUDGET_MIB);
  }, 120_000);
});
