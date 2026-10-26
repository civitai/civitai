import { readFileSync } from 'node:fs';

import { CIVITAI_SDK_FLOOR, checkSdkPin, installedSdkBelowFloor } from '@civitai/app-assistant';
import { describe, expect, it } from 'vitest';

const ROOT = JSON.parse(
  readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')
) as { dependencies: Record<string, string> };

describe('CIVITAI_SDK_FLOOR', () => {
  it('is the minor of the @civitai/sdk the host (the repo root) pins: bump the two together', () => {
    const root = ROOT.dependencies['@civitai/sdk'];
    expect(root).toMatch(/^\^\d+\.\d+\.\d+$/);
    const minor = (version: string) => version.replace(/^\^/, '').split('.').slice(0, 2).join('.');
    expect(minor(CIVITAI_SDK_FLOOR)).toBe(minor(root!));
  });
});

describe('checkSdkPin', () => {
  const pkg = (range: unknown, field = 'dependencies') => ({ [field]: { '@civitai/sdk': range } });

  it('judges a range by its own base version against the floor’s minor', () => {
    // Floors with a distinct major, minor and patch, so a check that read the wrong part fails.
    const floor = '1.21.3';
    expect(checkSdkPin(pkg('^1.20.9'), floor)).toEqual({ kind: 'stale', declared: '^1.20.9' });
    expect(checkSdkPin(pkg('~1.19.0'), floor)).toEqual({ kind: 'stale', declared: '~1.19.0' });
    expect(checkSdkPin(pkg('0.99.0'), floor)).toEqual({ kind: 'stale', declared: '0.99.0' });
    expect(checkSdkPin(pkg('^1.21.0'), floor)).toEqual({ kind: 'current', declared: '^1.21.0' });
    expect(checkSdkPin(pkg('1.22.0-beta.1'), floor)).toMatchObject({ kind: 'current' });
    expect(checkSdkPin(pkg('^2.0.0'), floor)).toMatchObject({ kind: 'current' });
    expect(checkSdkPin(pkg('^1.20.9', 'devDependencies'), floor)).toMatchObject({
      kind: 'stale',
    });
  });

  it('reads dependencies before devDependencies', () => {
    expect(
      checkSdkPin(
        {
          dependencies: { '@civitai/sdk': '^0.21.0' },
          devDependencies: { '@civitai/sdk': '^0.1.0' },
        },
        '0.21.0'
      )
    ).toMatchObject({ kind: 'current' });
  });

  it('says absent or unparseable rather than guessing', () => {
    expect(checkSdkPin({ dependencies: { vite: '^8.0.0' } }, '0.21.0')).toEqual({ kind: 'absent' });
    expect(checkSdkPin(null, '0.21.0')).toEqual({ kind: 'absent' });
    for (const range of ['latest', '*', '>=0.1.0', 'workspace:*', 'npm:@civitai/sdk@0.1.0', 19])
      expect(checkSdkPin(pkg(range), '0.21.0'), String(range)).toMatchObject({
        kind: 'unparseable',
      });
  });
});

describe('installedSdkBelowFloor', () => {
  it('compares an installed version’s major and minor with the floor’s', () => {
    expect(installedSdkBelowFloor('1.20.9', '1.21.3')).toBe(true);
    expect(installedSdkBelowFloor('0.99.0', '1.21.3')).toBe(true);
    expect(installedSdkBelowFloor('1.21.0', '1.21.3')).toBe(false);
    expect(installedSdkBelowFloor('1.22.0-beta.1', '1.21.3')).toBe(false);
    expect(installedSdkBelowFloor(undefined, '1.21.3')).toBeNull();
    expect(installedSdkBelowFloor('not-a-version', '1.21.3')).toBeNull();
  });
});
