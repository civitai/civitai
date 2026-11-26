import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  belowSdkFloor,
  judgeBundleSdkFloor,
  lockedSdkVersions,
  sdkFloorAdvisories,
  sdkFloorRecord,
} from '~/server/services/blocks/sdk-floor';

/**
 * The outdated-SDK check, server half. Fixture versions are chosen to differ from the published
 * floors (0.33.0 / 0.87.0) in every part, and package.json's RANGE deliberately disagrees with the
 * lockfile, so a reader of the wrong file — or one that hardcodes the floor — gives a different
 * answer.
 */

async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('block.manifest.json', '{}');
  for (const [path, text] of Object.entries(files)) zip.file(path, text);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

/** A package.json whose ranges claim to be at the floor. The lockfile below says otherwise. */
const PKG_AT_FLOOR_RANGE = JSON.stringify({
  dependencies: { '@civitai/sdk': '^0.33.0', '@civitai/blocks-react': '^0.87.0' },
});

const npmLock = (sdk: string, react?: string) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { '@civitai/sdk': '^0.33.0' } },
      'node_modules/@civitai/sdk': { version: sdk },
      ...(react ? { 'node_modules/@civitai/blocks-react': { version: react } } : {}),
      // A nested copy is not the one the app imports: never read.
      'node_modules/other/node_modules/@civitai/sdk': { version: '9.9.9' },
    },
  });

describe('lockedSdkVersions — reads the LOCKFILE, not package.json', () => {
  it('package-lock.json v3: the root install, not the range or a nested copy', async () => {
    const locked = await lockedSdkVersions(
      await zipOf({
        'package.json': PKG_AT_FLOOR_RANGE,
        'package-lock.json': npmLock('0.31.4', '0.80.2'),
      })
    );
    expect(locked?.lockfile).toBe('package-lock.json');
    expect(Object.fromEntries(locked!.versions)).toEqual({
      '@civitai/sdk': '0.31.4',
      '@civitai/blocks-react': '0.80.2',
    });
  });

  it('package-lock.json v1 dependencies', async () => {
    const locked = await lockedSdkVersions(
      await zipOf({
        'package-lock.json': JSON.stringify({
          lockfileVersion: 1,
          dependencies: { '@civitai/sdk': { version: '0.30.1' } },
        }),
      })
    );
    expect(Object.fromEntries(locked!.versions)).toEqual({ '@civitai/sdk': '0.30.1' });
  });

  it('pnpm-lock.yaml v9 importers, peer suffix stripped', async () => {
    const pnpm = [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      "      '@civitai/blocks-react':",
      '        specifier: ^0.87.0',
      '        version: 0.82.1(react@19.0.0)',
      "      '@civitai/sdk':",
      '        specifier: ^0.33.0',
      '        version: 0.32.5',
      '',
    ].join('\n');
    const locked = await lockedSdkVersions(await zipOf({ 'pnpm-lock.yaml': pnpm }));
    expect(locked?.lockfile).toBe('pnpm-lock.yaml');
    expect(Object.fromEntries(locked!.versions)).toEqual({
      '@civitai/sdk': '0.32.5',
      '@civitai/blocks-react': '0.82.1',
    });
  });

  it('yarn.lock v1', async () => {
    const yarn = [
      '# yarn lockfile v1',
      '',
      '"@civitai/sdk@^0.33.0":',
      '  version "0.29.7"',
      '  resolved "https://registry.yarnpkg.com/x"',
      '',
    ].join('\n');
    const locked = await lockedSdkVersions(await zipOf({ 'yarn.lock': yarn }));
    expect(locked?.lockfile).toBe('yarn.lock');
    expect(Object.fromEntries(locked!.versions)).toEqual({ '@civitai/sdk': '0.29.7' });
  });

  it('no lockfile: nothing to read', async () => {
    expect(await lockedSdkVersions(await zipOf({ 'package.json': PKG_AT_FLOOR_RANGE }))).toBeNull();
  });
});

describe('belowSdkFloor', () => {
  it('names each package below its minimum, in floor order', () => {
    expect(
      belowSdkFloor(
        new Map([
          ['@civitai/blocks-react', '0.80.2'],
          ['@civitai/sdk', '0.31.4'],
        ])
      )
    ).toEqual([
      { package: '@civitai/sdk', installed: '0.31.4', minimum: '0.33.0' },
      { package: '@civitai/blocks-react', installed: '0.80.2', minimum: '0.87.0' },
    ]);
  });

  it('at or above the floor is not below', () => {
    expect(
      belowSdkFloor(
        new Map([
          ['@civitai/sdk', '0.33.0'],
          ['@civitai/blocks-react', '0.88.1'],
        ])
      )
    ).toEqual([]);
  });

  it('compares the whole version against an arbitrary floor (major, minor, patch, pre-release)', () => {
    const floors = [{ name: '@civitai/sdk', minimum: '1.21.3' }];
    const judge = (v: string) => belowSdkFloor(new Map([['@civitai/sdk', v]]), floors).length > 0;
    expect(judge('1.21.2')).toBe(true);
    expect(judge('1.20.9')).toBe(true);
    expect(judge('0.99.0')).toBe(true);
    expect(judge('1.21.3-rc.1')).toBe(true);
    expect(judge('1.21.3')).toBe(false);
    expect(judge('1.22.0')).toBe(false);
    expect(judge('not-a-version')).toBe(false);
  });

  it('only blocks-react installed and below: only it is named', () => {
    expect(belowSdkFloor(new Map([['@civitai/blocks-react', '0.86.0']]))).toEqual([
      { package: '@civitai/blocks-react', installed: '0.86.0', minimum: '0.87.0' },
    ]);
  });
});

describe('sdkFloorAdvisories', () => {
  it('one advisory per package, with the upgrade command for the lockfile’s package manager', () => {
    expect(
      sdkFloorAdvisories('pnpm-lock.yaml', [
        { package: '@civitai/sdk', installed: '0.31.4', minimum: '0.33.0' },
      ])
    ).toEqual([
      {
        code: 'sdk-below-floor',
        message:
          "This app's pnpm-lock.yaml installs @civitai/sdk 0.31.4, below the platform minimum 0.33.0. " +
          'Upgrade with `pnpm add @civitai/sdk@latest` and resubmit. The submit was not refused; a ' +
          'moderator sees the version.',
      },
    ]);
  });

  it('nothing below: no advisory', () => {
    expect(sdkFloorAdvisories('package-lock.json', [])).toEqual([]);
  });
});

describe('judgeBundleSdkFloor — never fails or holds up a submit', () => {
  it('below-floor lockfile → its findings', async () => {
    await expect(
      judgeBundleSdkFloor(await zipOf({ 'package-lock.json': npmLock('0.31.4', '0.80.2') }))
    ).resolves.toEqual({
      lockfile: 'package-lock.json',
      below: [
        { package: '@civitai/sdk', installed: '0.31.4', minimum: '0.33.0' },
        { package: '@civitai/blocks-react', installed: '0.80.2', minimum: '0.87.0' },
      ],
    });
  });

  it('at-floor lockfile → nothing below', async () => {
    await expect(
      judgeBundleSdkFloor(await zipOf({ 'package-lock.json': npmLock('0.33.0', '0.87.0') }))
    ).resolves.toEqual({ lockfile: 'package-lock.json', below: [] });
  });

  it('a read that throws, or never settles, answers nothing', async () => {
    const none = { lockfile: null, below: [] };
    await expect(
      judgeBundleSdkFloor(Buffer.from('x'), {
        read: async () => {
          throw new Error('corrupt zip');
        },
      })
    ).resolves.toEqual(none);
    await expect(
      judgeBundleSdkFloor(Buffer.from('x'), {
        read: () => new Promise(() => undefined),
        timeoutMs: 50,
      })
    ).resolves.toEqual(none);
  });
});

describe('sdkFloorRecord', () => {
  const below = [{ package: '@civitai/sdk', installed: '0.31.4', minimum: '0.33.0' }];

  it('keeps the server reading and the client override apart', () => {
    expect(
      sdkFloorRecord({ lockfile: 'package-lock.json', below }, [
        { package: '@civitai/sdk', installed: '0.31.4', minimum: '0.33.0' },
      ])
    ).toEqual({
      lockfile: 'package-lock.json',
      below,
      override: [{ package: '@civitai/sdk', installed: '0.31.4', minimum: '0.33.0' }],
    });
  });

  it('below with no override (an older CLI): recorded, override null', () => {
    expect(sdkFloorRecord({ lockfile: 'yarn.lock', below }, undefined)).toEqual({
      lockfile: 'yarn.lock',
      below,
      override: null,
    });
  });

  it('nothing below and no override: nothing recorded', () => {
    expect(sdkFloorRecord({ lockfile: 'package-lock.json', below: [] }, undefined)).toBeNull();
    expect(sdkFloorRecord({ lockfile: null, below: [] }, [])).toBeNull();
  });
});
