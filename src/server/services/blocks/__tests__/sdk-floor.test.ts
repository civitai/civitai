import JSZip from 'jszip';
import semver from 'semver';
import { describe, expect, it } from 'vitest';
import { CIVITAI_BLOCKS_REACT_FLOOR, CIVITAI_SDK_FLOOR } from '@civitai/app-assistant/sdk-floor';
import {
  belowSdkFloor,
  judgeBundleSdkFloor,
  lockedSdkVersions,
  lockfileFor,
  sdkFloorAdvisories,
  sdkFloorRecord,
} from '~/server/services/blocks/sdk-floor';

/**
 * The outdated-SDK check, server half. Fixture versions are chosen to differ from the published
 * floors (`CIVITAI_SDK_FLOOR` / `CIVITAI_BLOCKS_REACT_FLOOR`) in every part, and package.json's
 * RANGE deliberately disagrees with the lockfile, so a reader of the wrong file — or one that
 * hardcodes the floor — gives a different answer. Where a case means "the floor" or "above it",
 * the value is built from the constants, so raising a floor does not edit this file.
 */

/** A version above each floor. */
const SDK_ABOVE = semver.inc(CIVITAI_SDK_FLOOR, 'minor')!;
const REACT_ABOVE = semver.inc(CIVITAI_BLOCKS_REACT_FLOOR, 'minor')!;

async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('block.manifest.json', '{}');
  for (const [path, text] of Object.entries(files)) zip.file(path, text);
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

/** A package.json whose ranges claim to be at the floor. The lockfile below says otherwise. */
const PKG_AT_FLOOR_RANGE = JSON.stringify({
  dependencies: {
    '@civitai/sdk': `^${CIVITAI_SDK_FLOOR}`,
    '@civitai/blocks-react': `^${CIVITAI_BLOCKS_REACT_FLOOR}`,
  },
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
      }),
      'npm run build'
    );
    expect(locked.lockfile).toBe('package-lock.json');
    expect(locked.lockfileStatus).toBe('read');
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
      }),
      undefined
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
    const locked = await lockedSdkVersions(await zipOf({ 'pnpm-lock.yaml': pnpm }), 'pnpm build');
    expect(locked.lockfile).toBe('pnpm-lock.yaml');
    expect(Object.fromEntries(locked!.versions)).toEqual({
      '@civitai/sdk': '0.32.5',
      '@civitai/blocks-react': '0.82.1',
    });
  });

  it('pnpm 11+ two-document lockfile: the project (last) document, not the boot document', async () => {
    // pnpm writes a leading boot document (its own version, config deps) before the project
    // lockfile when the project pins a package manager. Both documents carry `importers["."]`.
    const pnpm = [
      '---',
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    configDependencies: {}',
      '    packageManagerDependencies:',
      '      pnpm:',
      '        specifier: 12.3.4',
      '        version: 12.3.4',
      '',
      'packages:',
      '',
      '  pnpm@12.3.4:',
      '    resolution: {integrity: sha512-AAAA}',
      '',
      'snapshots:',
      '',
      '  pnpm@12.3.4: {}',
      '---',
      "lockfileVersion: '9.0'",
      '',
      'settings:',
      '  autoInstallPeers: true',
      '  excludeLinksFromLockfile: false',
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies:',
      "      '@civitai/blocks-react':",
      '        specifier: ^0.87.0',
      '        version: 0.81.3(react@19.0.0)',
      "      '@civitai/sdk':",
      '        specifier: ^0.33.0',
      '        version: 0.31.6',
      '',
    ].join('\n');
    const locked = await lockedSdkVersions(await zipOf({ 'pnpm-lock.yaml': pnpm }), 'pnpm build');
    expect(locked.lockfileStatus).toBe('read');
    expect(Object.fromEntries(locked.versions)).toEqual({
      '@civitai/sdk': '0.31.6',
      '@civitai/blocks-react': '0.81.3',
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
    const locked = await lockedSdkVersions(await zipOf({ 'yarn.lock': yarn }), 'yarn run build');
    expect(locked.lockfile).toBe('yarn.lock');
    expect(Object.fromEntries(locked!.versions)).toEqual({ '@civitai/sdk': '0.29.7' });
  });

  it('yarn berry (`version: x` form, `npm:` header)', async () => {
    const yarn = [
      '__metadata:',
      '  version: 8',
      '',
      '"@civitai/sdk@npm:^0.33.0":',
      '  version: 0.28.3',
      '  resolution: "@civitai/sdk@npm:0.28.3"',
      '',
    ].join('\n');
    const locked = await lockedSdkVersions(await zipOf({ 'yarn.lock': yarn }), 'yarn run build');
    expect(locked.lockfileStatus).toBe('read');
    expect(Object.fromEntries(locked.versions)).toEqual({ '@civitai/sdk': '0.28.3' });
  });

  it('yarn with more than one resolved version of a package: no version for it', async () => {
    const yarn = [
      '# yarn lockfile v1',
      '',
      '"@civitai/sdk@^0.29.0":',
      '  version "0.29.7"',
      '',
      '"@civitai/sdk@^0.31.0":',
      '  version "0.31.2"',
      '',
      '"@civitai/blocks-react@^0.80.0":',
      '  version "0.81.6"',
      '',
    ].join('\n');
    const locked = await lockedSdkVersions(await zipOf({ 'yarn.lock': yarn }), 'yarn run build');
    expect(Object.fromEntries(locked.versions)).toEqual({ '@civitai/blocks-react': '0.81.6' });
  });

  it('pnpm v5 (top-level bare string, `_` peer suffix) and v6 (top-level `{ specifier, version }`)', async () => {
    const v5 = [
      'lockfileVersion: 5.4',
      'specifiers:',
      "  '@civitai/sdk': ^0.33.0",
      'dependencies:',
      "  '@civitai/sdk': 0.27.9_react@18.2.0",
      'devDependencies:',
      "  '@civitai/blocks-react': 0.79.4",
      '',
    ].join('\n');
    const v6 = [
      "lockfileVersion: '6.0'",
      'dependencies:',
      "  '@civitai/sdk':",
      '    specifier: ^0.33.0',
      '    version: 0.26.8(react@18.2.0)',
      '',
    ].join('\n');
    const r5 = await lockedSdkVersions(await zipOf({ 'pnpm-lock.yaml': v5 }), 'pnpm run build');
    const r6 = await lockedSdkVersions(await zipOf({ 'pnpm-lock.yaml': v6 }), 'pnpm run build');
    expect(Object.fromEntries(r5.versions)).toEqual({
      '@civitai/sdk': '0.27.9',
      '@civitai/blocks-react': '0.79.4',
    });
    expect(Object.fromEntries(r6.versions)).toEqual({ '@civitai/sdk': '0.26.8' });
  });

  it('no lockfile: absent, nothing read', async () => {
    const locked = await lockedSdkVersions(
      await zipOf({ 'package.json': PKG_AT_FLOOR_RANGE }),
      'npm run build'
    );
    expect(locked).toEqual({
      lockfile: 'package-lock.json',
      lockfileStatus: 'absent',
      versions: new Map(),
    });
  });

  it('an unparseable lockfile: unreadable, nothing read', async () => {
    const npm = await lockedSdkVersions(
      await zipOf({ 'package-lock.json': '{"lockfileVersion": 3, "packages": {' }),
      'npm run build'
    );
    const pnpm = await lockedSdkVersions(
      await zipOf({ 'pnpm-lock.yaml': 'importers:\n  .: [unclosed\n' }),
      'pnpm run build'
    );
    expect(npm.lockfileStatus).toBe('unreadable');
    expect(pnpm.lockfileStatus).toBe('unreadable');
    expect(npm.versions.size + pnpm.versions.size).toBe(0);
  });
});

/**
 * The lockfile is the one the BUILD installs from, chosen by buildCommand as civitai/cli's
 * `packageManagerFor` chooses it — not the first one present. Each case carries a STALE lockfile
 * of another manager beside the real one, at a version that would answer the opposite way.
 */
describe('lockfileFor / lockfile choice follows buildCommand', () => {
  it('first word of the trimmed buildCommand; everything else is npm', () => {
    expect(lockfileFor('pnpm build')).toBe('pnpm-lock.yaml');
    expect(lockfileFor('  pnpm run build ')).toBe('pnpm-lock.yaml');
    expect(lockfileFor('yarn run build')).toBe('yarn.lock');
    expect(lockfileFor('npm run build')).toBe('package-lock.json');
    expect(lockfileFor('vite build')).toBe('package-lock.json');
    expect(lockfileFor('npx vite build')).toBe('package-lock.json');
    expect(lockfileFor('pnpmx build')).toBe('package-lock.json');
    expect(lockfileFor('')).toBe('package-lock.json');
    expect(lockfileFor(undefined)).toBe('package-lock.json');
    expect(lockfileFor(42)).toBe('package-lock.json');
  });

  const pnpmLock = (sdk: string) =>
    [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      "      '@civitai/sdk':",
      '        specifier: ^0.33.0',
      `        version: ${sdk}`,
      '',
    ].join('\n');

  it('pnpm build: a current pnpm-lock beside a stale package-lock → no finding', async () => {
    const zip = await zipOf({
      'package-lock.json': npmLock('0.30.0'),
      'pnpm-lock.yaml': pnpmLock(SDK_ABOVE),
    });
    await expect(judgeBundleSdkFloor(zip, 'pnpm build')).resolves.toEqual({
      lockfile: 'pnpm-lock.yaml',
      lockfileStatus: 'read',
      below: [],
    });
  });

  it('npm run build: a stale package-lock beside a current pnpm-lock → finding', async () => {
    const zip = await zipOf({
      'package-lock.json': npmLock('0.30.0'),
      'pnpm-lock.yaml': pnpmLock(SDK_ABOVE),
    });
    await expect(judgeBundleSdkFloor(zip, 'npm run build')).resolves.toEqual({
      lockfile: 'package-lock.json',
      lockfileStatus: 'read',
      below: [{ package: '@civitai/sdk', installed: '0.30.0', minimum: CIVITAI_SDK_FLOOR }],
    });
  });

  it('pnpm build with only a package-lock: absent (the other lockfile is never a fallback)', async () => {
    await expect(
      judgeBundleSdkFloor(await zipOf({ 'package-lock.json': npmLock('0.30.0') }), 'pnpm build')
    ).resolves.toEqual({ lockfile: 'pnpm-lock.yaml', lockfileStatus: 'absent', below: [] });
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
      { package: '@civitai/sdk', installed: '0.31.4', minimum: CIVITAI_SDK_FLOOR },
      {
        package: '@civitai/blocks-react',
        installed: '0.80.2',
        minimum: CIVITAI_BLOCKS_REACT_FLOOR,
      },
    ]);
  });

  it('at or above the floor is not below', () => {
    expect(
      belowSdkFloor(
        new Map([
          ['@civitai/sdk', CIVITAI_SDK_FLOOR],
          ['@civitai/blocks-react', REACT_ABOVE],
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
      {
        package: '@civitai/blocks-react',
        installed: '0.86.0',
        minimum: CIVITAI_BLOCKS_REACT_FLOOR,
      },
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
      judgeBundleSdkFloor(
        await zipOf({ 'package-lock.json': npmLock('0.31.4', '0.80.2') }),
        'npm run build'
      )
    ).resolves.toEqual({
      lockfile: 'package-lock.json',
      lockfileStatus: 'read',
      below: [
        { package: '@civitai/sdk', installed: '0.31.4', minimum: CIVITAI_SDK_FLOOR },
        {
          package: '@civitai/blocks-react',
          installed: '0.80.2',
          minimum: CIVITAI_BLOCKS_REACT_FLOOR,
        },
      ],
    });
  });

  it('at-floor lockfile → nothing below', async () => {
    await expect(
      judgeBundleSdkFloor(
        await zipOf({
          'package-lock.json': npmLock(CIVITAI_SDK_FLOOR, CIVITAI_BLOCKS_REACT_FLOOR),
        }),
        'npm run build'
      )
    ).resolves.toEqual({ lockfile: 'package-lock.json', lockfileStatus: 'read', below: [] });
  });

  it('a read that throws, or never settles, answers unreadable with nothing below', async () => {
    const none = { lockfile: 'yarn.lock', lockfileStatus: 'unreadable', below: [] };
    await expect(
      judgeBundleSdkFloor(Buffer.from('x'), 'yarn run build', {
        read: async () => {
          throw new Error('corrupt zip');
        },
      })
    ).resolves.toEqual(none);
    await expect(
      judgeBundleSdkFloor(Buffer.from('x'), 'yarn run build', {
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
      sdkFloorRecord({ lockfile: 'package-lock.json', lockfileStatus: 'read', below }, [
        { package: '@civitai/sdk', installed: '0.31.4', minimum: '0.33.0' },
      ])
    ).toEqual({
      lockfile: 'package-lock.json',
      lockfileStatus: 'read',
      below,
      override: [{ package: '@civitai/sdk', installed: '0.31.4', minimum: '0.33.0' }],
    });
  });

  it('below with no override (an older CLI): recorded, override null', () => {
    expect(
      sdkFloorRecord({ lockfile: 'yarn.lock', lockfileStatus: 'read', below }, undefined)
    ).toEqual({
      lockfile: 'yarn.lock',
      lockfileStatus: 'read',
      below,
      override: null,
    });
  });

  it('nothing below and no override: nothing recorded', () => {
    expect(
      sdkFloorRecord(
        { lockfile: 'package-lock.json', lockfileStatus: 'read', below: [] },
        undefined
      )
    ).toBeNull();
    expect(
      sdkFloorRecord({ lockfile: 'yarn.lock', lockfileStatus: 'absent', below: [] }, [])
    ).toBeNull();
  });
});
