import { describe, expect, it } from 'vitest';
import { reviewPlatformUpdatesLines } from '~/components/Apps/reviewPlatformUpdates';

describe('reviewPlatformUpdatesLines', () => {
  it('names each missing update and its paths, labelled for the submit override', () => {
    expect(
      reviewPlatformUpdatesLines({
        files: [],
        platformUpdatesMissing: {
          via: 'override',
          updates: [
            { id: 'apu_1', by: 'mod-jane', paths: ['src/a.ts', 'package.json'] },
            { id: 'apu_2', by: null, paths: ['src/old.ts'] },
          ],
        },
      })
    ).toEqual([
      {
        key: 'platform-updates',
        heading: 'Missing platform updates (submitted with --allow-unmerged-platform-update)',
        value: 'apu_1 by mod-jane: src/a.ts, package.json; apu_2 by Civitai staff: src/old.ts',
      },
    ]);
  });

  it('labels a git push as recorded without them', () => {
    expect(
      reviewPlatformUpdatesLines({
        platformUpdatesMissing: {
          via: 'push',
          updates: [{ id: 'apu_3', by: 'mod-jane', paths: ['x.ts'] }],
        },
      })
    ).toEqual([
      {
        key: 'platform-updates',
        heading: 'Missing platform updates (git push, recorded without them)',
        value: 'apu_3 by mod-jane: x.ts',
      },
    ]);
  });

  it('labels a staff on-behalf submission, marks an unreadable update and a capped check', () => {
    expect(
      reviewPlatformUpdatesLines({
        platformUpdatesMissing: {
          via: 'on-behalf',
          updates: [
            { id: 'apu_4', by: 'mod-jane', paths: ['a.ts'], unreadable: true },
            { id: 'apu_5', by: 'mod-ana', paths: ['b.ts'] },
          ],
          truncated: true,
        },
      })
    ).toEqual([
      {
        key: 'platform-updates',
        heading: "Missing platform updates (Civitai staff submission on the owner's behalf)",
        value:
          'apu_4 by mod-jane: a.ts (could not be read); apu_5 by mod-ana: b.ts; ' +
          'more unshipped updates were not checked',
      },
    ]);
  });

  it('shows nothing when nothing is recorded or the record is malformed', () => {
    expect(reviewPlatformUpdatesLines({ files: [] })).toEqual([]);
    expect(reviewPlatformUpdatesLines(null)).toEqual([]);
    expect(
      reviewPlatformUpdatesLines({ platformUpdatesMissing: { via: 'push', updates: [] } })
    ).toEqual([]);
    expect(
      reviewPlatformUpdatesLines({
        platformUpdatesMissing: { via: 'push', updates: [{ by: 'x' }] },
      })
    ).toEqual([]);
  });
});
