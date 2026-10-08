import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Pipeline from '~/server/services/resource-intent-cooc/pipeline';
import type * as Store from '~/server/services/resource-intent-cooc/store';

const { mockRelease, mockBuild } = vi.hoisted(() => ({
  mockRelease: vi.fn(),
  mockBuild: vi.fn(),
}));
vi.mock('~/server/services/resource-intent-cooc/store', async (importOriginal) => ({
  ...(await importOriginal<typeof Store>()),
  releaseCoocSnapshot: mockRelease,
}));
vi.mock('~/server/services/resource-intent-cooc/pipeline', async (importOriginal) => ({
  ...(await importOriginal<typeof Pipeline>()),
  buildCoocSnapshot: mockBuild,
}));

import { main, parseCoocScriptArgs } from '../build-resource-intent-cooc';

const HASH = 'a'.repeat(64);

describe('build-resource-intent-cooc flags', () => {
  it.each([
    ['no --kind at all', [], /--kind production or --kind study is required/],
    ['--train-end alone', ['--train-end', '2026-09-01'], /--kind .* is required/],
    ['--pin-until alone', ['--pin-until', '2026-11-01'], /--kind .* is required/],
    ['--dry-run alone', ['--dry-run'], /--kind .* is required/],
    ['an unknown kind', ['--kind', 'staging'], /--kind .* is required/],
    ['study without a pin', ['--kind', 'study'], /requires --pin-until/],
    [
      'study with only a train end',
      ['--kind', 'study', '--train-end', '2026-09-01'],
      /requires --pin-until/,
    ],
    [
      'production with a pin',
      ['--kind', 'production', '--pin-until', '2026-11-01'],
      /cannot take --pin-until/,
    ],
    [
      'production with a train end',
      ['--kind', 'production', '--train-end', '2026-09-01'],
      /no backdating/,
    ],
    ['a bad date', ['--kind', 'study', '--pin-until', 'soon'], /not a date/],
    ['a fractional seed', ['--kind', 'production', '--seed', '1.5'], /not a non-negative integer/],
    ['a negative seed', ['--kind', 'production', '--seed=-3'], /not a non-negative integer/],
    [
      '--release with --kind',
      ['--release', HASH, '--kind', 'study'],
      /standalone mode; it rejects --kind/,
    ],
    [
      '--release with --train-end',
      ['--release', HASH, '--train-end', '2026-09-01'],
      /rejects --train-end/,
    ],
    [
      '--release with --pin-until',
      ['--release', HASH, '--pin-until', '2026-11-01'],
      /rejects --pin-until/,
    ],
    ['--release with --seed', ['--release', HASH, '--seed', '1'], /rejects --seed/],
    ['--release with a non-hash', ['--release', 'abc'], /not a content hash/],
    ['an unknown flag', ['--kind', 'production', '--force'], /Unknown option/],
  ])('rejects %s', (_name, argv, err) => {
    expect(() => parseCoocScriptArgs(argv as string[])).toThrow(err as RegExp);
  });

  it('accepts a production build, with or without --dry-run', () => {
    expect(parseCoocScriptArgs(['--kind', 'production'])).toEqual({
      action: 'build',
      kind: 'production',
      trainEnd: undefined,
      pinnedUntil: null,
      seed: undefined,
      dryRun: false,
    });
    expect(parseCoocScriptArgs(['--kind', 'production', '--dry-run'])).toMatchObject({
      dryRun: true,
    });
  });

  it('accepts a pinned study build with a train end and a seed', () => {
    expect(
      parseCoocScriptArgs([
        '--kind',
        'study',
        '--pin-until',
        '2026-11-01T00:00:00Z',
        '--train-end',
        '2026-09-07T03:00:22.835Z',
        '--seed',
        '7',
        '--dry-run',
      ])
    ).toEqual({
      action: 'build',
      kind: 'study',
      trainEnd: new Date('2026-09-07T03:00:22.835Z'),
      pinnedUntil: new Date('2026-11-01T00:00:00Z'),
      seed: 7,
      dryRun: true,
    });
  });

  it('accepts --release alone, and --release --dry-run (report only)', () => {
    expect(parseCoocScriptArgs(['--release', HASH])).toEqual({
      action: 'release',
      contentHash: HASH,
      dryRun: false,
    });
    expect(parseCoocScriptArgs(['--release', HASH, '--dry-run'])).toEqual({
      action: 'release',
      contentHash: HASH,
      dryRun: true,
    });
  });

  describe('main passes the parsed mode through', () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockRelease.mockResolvedValue({ id: 'row', deleted: false });
      mockBuild.mockResolvedValue({ contentHash: 'h' });
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    it('--release --dry-run releases nothing and builds nothing', async () => {
      await main(['--release', HASH, '--dry-run']);
      expect(mockRelease).toHaveBeenCalledTimes(1);
      expect(mockRelease.mock.calls[0][1]).toBe(HASH);
      expect(mockRelease.mock.calls[0][2]).toEqual({ dryRun: true });
      expect(mockBuild).not.toHaveBeenCalled();
    });

    it('--release without --dry-run deletes', async () => {
      await main(['--release', HASH]);
      expect(mockRelease.mock.calls[0][2]).toEqual({ dryRun: false });
    });

    it('a build --dry-run reaches the pipeline as a dry run, with the default seed', async () => {
      await main(['--kind', 'production', '--dry-run']);
      expect(mockBuild).toHaveBeenCalledWith({
        kind: 'production',
        trainEnd: undefined,
        pinnedUntil: null,
        seed: 20261008,
        dryRun: true,
      });
      expect(mockRelease).not.toHaveBeenCalled();
    });
  });

  it('a study build passes its kind, train end, pin and seed through unchanged', async () => {
    mockBuild.mockResolvedValue({ contentHash: 'h' });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await main([
      '--kind',
      'study',
      '--pin-until',
      '2026-11-20T00:00:00Z',
      '--train-end',
      '2026-09-07T03:00:22.835Z',
      '--seed',
      '7',
    ]);
    expect(mockBuild).toHaveBeenLastCalledWith({
      kind: 'study',
      trainEnd: new Date('2026-09-07T03:00:22.835Z'),
      pinnedUntil: new Date('2026-11-20T00:00:00Z'),
      seed: 7,
      dryRun: false,
    });
  });
});
