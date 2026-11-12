import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_AUTHOR,
  approvedSeedCommitMessage,
  assistantCommitMessage,
  forkSeedCommitMessage,
  gitBlobSha,
  isTrailerSafe,
  planAssistantCommit,
  planReplaceCommit,
  sourceFilesFromExport,
  sourceRepoHttpUrl,
  treeOf,
  SourceFilesError,
} from '~/server/services/blocks/app-source-repo.plan';
import { MAX_FILES_IN_BUNDLE } from '~/server/schema/blocks/publish-request.schema';

/**
 * Source repos — the pure decisions: what a commit changes (the compare-and-set plan), what its
 * message and trailers say, and which files of an App Assistant export are committed. All new
 * surface (invariant guards); the mutation targets are named per case.
 */

const buf = (s: string) => Buffer.from(s, 'utf8');
const SHA_A = 'a'.repeat(40);
const SHA_B = '0123456789abcdef0123456789abcdef01234567';

describe('gitBlobSha', () => {
  it('is git’s own blob id (`printf "hello\\n" | git hash-object --stdin`)', () => {
    expect(gitBlobSha(buf('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
});

describe('planAssistantCommit — the compare-and-set plan', () => {
  const baseline = treeOf([
    { path: 'a.ts', content: buf('a1') },
    { path: 'b.ts', content: buf('b1') },
    { path: 'gone.ts', content: buf('g1') },
  ]);

  it('touches only what the assistant changed since its last save, each op naming the blob it expects', () => {
    const plan = planAssistantCommit(baseline, [
      { path: 'a.ts', content: buf('a2') },
      { path: 'b.ts', content: buf('b1') },
      { path: 'new.ts', content: buf('n1') },
    ]);
    expect(plan.operations).toEqual([
      { operation: 'update', path: 'a.ts', content: buf('a2'), sha: gitBlobSha(buf('a1')) },
      { operation: 'create', path: 'new.ts', content: buf('n1') },
      { operation: 'delete', path: 'gone.ts', sha: gitBlobSha(buf('g1')) },
    ]);
    expect(plan).toMatchObject({ added: ['new.ts'], updated: ['a.ts'], deleted: ['gone.ts'] });
  });

  it('an unchanged save plans nothing (no commit)', () => {
    const files = [
      { path: 'a.ts', content: buf('a1') },
      { path: 'b.ts', content: buf('b1') },
      { path: 'gone.ts', content: buf('g1') },
    ];
    expect(planAssistantCommit(baseline, files).operations).toEqual([]);
  });

  it('a file the DEVELOPER changed but the assistant did not is never in the plan', () => {
    // The developer pushed a new b.ts; the assistant's view of b.ts is still b1, unchanged by it.
    const plan = planAssistantCommit(baseline, [
      { path: 'a.ts', content: buf('a2') },
      { path: 'b.ts', content: buf('b1') },
      { path: 'gone.ts', content: buf('g1') },
    ]);
    expect(plan.operations.map((o) => o.path)).toEqual(['a.ts']);
  });

  it('planReplaceCommit makes a branch hold exactly the files, against the tree it holds now', () => {
    const current = treeOf([
      { path: 'README.md', content: buf('auto-init') },
      { path: 'a.ts', content: buf('dev') },
    ]);
    const plan = planReplaceCommit(current, [{ path: 'a.ts', content: buf('a2') }]);
    expect(plan.operations).toEqual([
      { operation: 'update', path: 'a.ts', content: buf('a2'), sha: gitBlobSha(buf('dev')) },
      { operation: 'delete', path: 'README.md', sha: gitBlobSha(buf('auto-init')) },
    ]);
  });
});

describe('commit messages', () => {
  it('an assistant save: a summary derived from the change, and the user it was made for (whole string)', () => {
    const plan = planAssistantCommit(
      treeOf([
        { path: 'x.ts', content: buf('1') },
        { path: 'y.ts', content: buf('1') },
        { path: 'z.ts', content: buf('1') },
      ]),
      [
        { path: 'src/App.tsx', content: buf('new') },
        { path: 'x.ts', content: buf('2') },
        { path: 'y.ts', content: buf('2') },
      ]
    );
    expect(assistantCommitMessage(plan, 'dev-7101')).toBe(
      'App Assistant: add src/App.tsx, update 2 files, delete z.ts\n\n' +
        'Assisted-by: Civitai App Assistant\n' +
        'On-behalf-of: dev-7101'
    );
    expect(ASSISTANT_AUTHOR.name).toBe('Civitai App Assistant');
  });

  it('an on-behalf-of value that is not trailer-safe is omitted, never escaped', () => {
    const plan = planAssistantCommit({}, [{ path: 'a', content: buf('1') }]);
    expect(assistantCommitMessage(plan, 'dev-1\nForged-By: x')).toBe(
      'App Assistant: add a\n\nAssisted-by: Civitai App Assistant'
    );
  });

  it('a fork seed: Forked-From-* exactly as given (whole string)', () => {
    expect(forkSeedCommitMessage({ parentSlug: 'pixel-garden', parentCommitSha: SHA_B })).toBe(
      `Fork of pixel-garden\n\nForked-From-App: pixel-garden\nForked-From-Commit: ${SHA_B}`
    );
  });

  it('a fork seed with a parent slug or sha that is not one: that trailer is left out', () => {
    expect(
      forkSeedCommitMessage({ parentSlug: 'Evil\nForked-From-App: x', parentCommitSha: SHA_A })
    ).toBe(`Fork\n\nForked-From-Commit: ${SHA_A}`);
    expect(forkSeedCommitMessage({ parentSlug: 'pixel-garden', parentCommitSha: 'HEAD' })).toBe(
      'Fork of pixel-garden\n\nForked-From-App: pixel-garden'
    );
  });

  it('a backfill seed: the approved commit, and the lineage when the app is a fork', () => {
    expect(approvedSeedCommitMessage({ version: '1.2.3', approvedCommitSha: SHA_A })).toBe(
      `Import v1.2.3\n\nApproved-Commit: ${SHA_A}`
    );
    expect(
      approvedSeedCommitMessage({
        version: '0.4.0',
        approvedCommitSha: SHA_A,
        lineage: { parentSlug: 'pixel-garden', parentCommitSha: SHA_B },
      })
    ).toBe(
      `Import v0.4.0\n\nApproved-Commit: ${SHA_A}\nForked-From-App: pixel-garden\nForked-From-Commit: ${SHA_B}`
    );
  });

  it('isTrailerSafe: one printable line of at most 200', () => {
    expect(isTrailerSafe('dev-12')).toBe(true);
    expect(isTrailerSafe('Civitai App Assistant')).toBe(true);
    for (const bad of ['', 'a\nb', 'a\rb', 'a\u0000b', 'a\tb', ' lead', 'x'.repeat(201)])
      expect(isTrailerSafe(bad)).toBe(false);
  });
});

describe('sourceFilesFromExport — what of an export is committed', () => {
  const entries = (paths: string[]) => paths.map((path) => ({ path, content: buf(path) }));

  it('takes the app folder’s prefix off, and leaves out what the CLI and a fork seed leave out', () => {
    const files = sourceFilesFromExport(
      entries([
        'my-app/block.manifest.json',
        'my-app/src/index.ts',
        'my-app/scratch/probe.ts',
        'my-app/old.zip',
        'my-app/.env.local',
        'my-app/keys/server.pem',
        'my-app/.npmrc',
        'my-app/node_modules/x/index.js',
        'my-app/dist/bundle.js',
        'other-app/src/index.ts',
        'my-app/dir/',
      ]),
      'my-app'
    );
    expect(files.map((f) => f.path)).toEqual(['block.manifest.json', 'src/index.ts']);
  });

  it('an export with the manifest at its root is used as it is', () => {
    expect(
      sourceFilesFromExport(entries(['block.manifest.json', 'src/a.ts']), 'my-app').map(
        (f) => f.path
      )
    ).toEqual(['block.manifest.json', 'src/a.ts']);
  });

  it('a path that escapes the tree is left out', () => {
    expect(
      sourceFilesFromExport(
        entries(['my-app/block.manifest.json', 'my-app/../etc/passwd', 'my-app/a/./b']),
        'my-app'
      ).map((f) => f.path)
    ).toEqual(['block.manifest.json']);
  });

  it(`refuses past ${MAX_FILES_IN_BUNDLE} files`, () => {
    const many = Array.from({ length: MAX_FILES_IN_BUNDLE + 1 }, (_, i) => `my-app/f${i}.ts`);
    expect(() => sourceFilesFromExport(entries(many), 'my-app')).toThrow(SourceFilesError);
    expect(() =>
      sourceFilesFromExport(entries(many.slice(0, MAX_FILES_IN_BUNDLE)), 'my-app')
    ).not.toThrow();
  });
});

describe('sourceRepoHttpUrl', () => {
  it('is the token-less https URL on the public host, with or without a scheme or slash', () => {
    for (const host of ['https://git.example.test/', 'git.example.test', 'http://git.example.test'])
      expect(sourceRepoHttpUrl(host, 'civitai-apps-src', 'my-app')).toBe(
        'https://git.example.test/civitai-apps-src/my-app.git'
      );
  });
});
