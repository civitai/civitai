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

  it('an override the server could not confirm from a lockfile', () => {
    expect(
      reviewSdkFloorLines({
        ...files,
        sdkFloor: {
          lockfile: null,
          below: [],
          override: [{ package: '@civitai/sdk', installed: '0.30.0', minimum: '0.33.0' }],
        },
      })[0]
    ).toEqual({
      key: 'bundle',
      heading: 'Outdated SDK (read from the bundle lockfile)',
      value: 'no lockfile the server reads',
    });
  });

  it('a request that records nothing, or a pre-existing row, renders nothing', () => {
    expect(reviewSdkFloorLines(files)).toEqual([]);
    expect(reviewSdkFloorLines(null)).toEqual([]);
    expect(reviewSdkFloorLines({ sdkFloor: 'garbage' })).toEqual([]);
  });
});
