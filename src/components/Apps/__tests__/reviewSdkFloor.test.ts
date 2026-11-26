import { describe, expect, it } from 'vitest';
import { reviewSdkFloorLines } from '~/components/Apps/reviewSdkFloor';

/** What the moderator reads for a submission's SDK versions, pinned as literals. */
describe('reviewSdkFloorLines', () => {
  const files = { files: [], added: [], removed: [], changed: [] };

  it('an override submit: the lockfile reading AND the override, on separate labelled lines', () => {
    expect(
      reviewSdkFloorLines({
        ...files,
        sdkFloor: {
          lockfile: 'package-lock.json',
          below: [
            { package: '@civitai/sdk', installed: '0.31.4', minimum: '0.33.0' },
            { package: '@civitai/blocks-react', installed: '0.80.2', minimum: '0.87.0' },
          ],
          override: [{ package: '@civitai/sdk', installed: '0.31.4', minimum: '0.33.0' }],
        },
      })
    ).toEqual([
      {
        key: 'bundle',
        heading: 'Outdated SDK (read from the bundle lockfile)',
        value:
          '@civitai/sdk 0.31.4 (minimum 0.33.0), @civitai/blocks-react 0.80.2 (minimum 0.87.0)',
      },
      {
        key: 'override',
        heading: 'Outdated-SDK override (sent by the client, not checked)',
        value: 'submitted with --allow-outdated-sdk: @civitai/sdk 0.31.4 (minimum 0.33.0)',
      },
    ]);
  });

  it('below with no override (a CLI that predates the check)', () => {
    expect(
      reviewSdkFloorLines({
        ...files,
        sdkFloor: {
          lockfile: 'yarn.lock',
          below: [{ package: '@civitai/blocks-react', installed: '0.84.0', minimum: '0.87.0' }],
          override: null,
        },
      })
    ).toEqual([
      {
        key: 'bundle',
        heading: 'Outdated SDK (read from the bundle lockfile)',
        value: '@civitai/blocks-react 0.84.0 (minimum 0.87.0)',
      },
      {
        key: 'override',
        heading: 'Outdated-SDK override (sent by the client, not checked)',
        value: 'none sent (the submitting client did not run the outdated-SDK check)',
      },
    ]);
  });

  /** The bundle line when nothing is below, for each thing the server could make of the lockfile. */
  const bundleLineFor = (sdkFloor: Record<string, unknown>) =>
    reviewSdkFloorLines({
      ...files,
      sdkFloor: {
        below: [],
        override: [{ package: '@civitai/sdk', installed: '0.30.0', minimum: '0.33.0' }],
        ...sdkFloor,
      },
    })[0];

  it('an override the server read the lockfile for and found nothing below', () => {
    expect(bundleLineFor({ lockfile: 'pnpm-lock.yaml', lockfileStatus: 'read' })).toEqual({
      key: 'bundle',
      heading: 'Outdated SDK (read from the bundle lockfile)',
      value: 'none below the minimum in pnpm-lock.yaml',
    });
  });

  it('an override with NO lockfile in the bundle', () => {
    expect(bundleLineFor({ lockfile: 'package-lock.json', lockfileStatus: 'absent' })).toEqual({
      key: 'bundle',
      heading: 'Outdated SDK (read from the bundle lockfile)',
      value:
        'the bundle carries no package-lock.json (the lockfile its build command installs from)',
    });
  });

  it('an override whose lockfile could not be read (unparseable or timed out)', () => {
    expect(bundleLineFor({ lockfile: 'yarn.lock', lockfileStatus: 'unreadable' })).toEqual({
      key: 'bundle',
      heading: 'Outdated SDK (read from the bundle lockfile)',
      value: 'yarn.lock could not be read (unparseable, or the read timed out)',
    });
  });

  it('a reading with no recognisable lockfile or status says so, never "none below"', () => {
    expect(bundleLineFor({ lockfile: null, lockfileStatus: 'read' })?.value).toBe(
      'no lockfile reading recorded'
    );
    expect(bundleLineFor({ lockfile: 'package-lock.json' })?.value).toBe(
      'no lockfile reading recorded'
    );
  });

  it('a request that records nothing, or a pre-existing row, renders nothing', () => {
    expect(reviewSdkFloorLines(files)).toEqual([]);
    expect(reviewSdkFloorLines(null)).toEqual([]);
    expect(reviewSdkFloorLines({ sdkFloor: 'garbage' })).toEqual([]);
  });
});
