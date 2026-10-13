import { describe, expect, it } from 'vitest';
import {
  SDK_VERSION_LABEL_COUNT,
  SDK_VERSION_MAX_MAJOR,
  SDK_NAMES,
  SDK_VERSION_MAX_MINOR,
  hasBlockReadySdk,
  readBlockReadySdk,
  sdkNameLabel,
  sdkVersionLabel,
} from '../blockSdkVersion';

/**
 * `sdkVersionLabel` and `sdkNameLabel` are the cardinality bounds on the `sdk_version`
 * and `sdk` prom labels. The values they reduce come from an untrusted iframe and then
 * from a public beacon body, so the property under test is not "it parses semver" but
 * "no input can produce a value outside one closed, enumerable set".
 */

// Everything the bound must refuse to turn into a version label.
const HOSTILE: Array<[string, unknown]> = [
  ['null', null],
  ['empty string', ''],
  ['whitespace', '   '],
  ['a number', 73],
  ['NaN', Number.NaN],
  ['a boolean', true],
  ['an array', ['0.73.0']],
  ['an object', { major: 0, minor: 73 }],
  ['an object with toString', { toString: () => '0.73.0' }],
  ['a String object', new String('0.73.0')],
  ['a symbol', Symbol('0.73.0')],
  ['a function', () => '0.73.0'],
  ['a bigint', BigInt(73)],
  ['major.minor only', '0.73'],
  ['four components', '0.73.0.1'],
  ['v prefix', 'v0.73.0'],
  ['= prefix', '=0.73.0'],
  ['prerelease suffix', '0.73.0-beta.1'],
  ['build suffix', '0.73.0+build.5'],
  ['prerelease and build', '0.73.0-rc.1+sha.abcdef'],
  ['leading whitespace', ' 0.73.0'],
  ['trailing whitespace', '0.73.0 '],
  ['trailing newline', '0.73.0\n'],
  ['embedded newline', '0.73\n.0'],
  ['NUL byte', '0.73.0\u0000'],
  ['control character', '0.\u00077.0'],
  ['leading zero minor', '0.073.0'],
  ['leading zero major', '00.73.0'],
  ['leading zero patch', '0.73.00'],
  ['negative component', '0.-73.0'],
  ['signed component', '+0.73.0'],
  ['exponent', '0.7e1.0'],
  ['hex', '0x0.73.0'],
  ['decimal component', '0.73.0.'],
  ['empty component', '0..0'],
  ['wildcard', '0.x.0'],
  ['range', '^0.73.0'],
  ['fullwidth digits', '０.７３.０'],
  ['arabic-indic digits', '٠.٧٣.٠'],
  ['minor one above the ceiling', `0.${SDK_VERSION_MAX_MINOR + 1}.0`],
  ['major one above the ceiling', `${SDK_VERSION_MAX_MAJOR + 1}.0.0`],
  ['three-digit minor above the ceiling', '0.999.0'],
  ['huge minor', '0.99999999999999999999.0'],
  ['huge major', '99999999999999999999.0.0'],
  ['huge patch', '0.73.99999999999999999999'],
  ['seven-digit patch', '0.73.1000000'],
  ['a very long digit run', '1'.repeat(100_000)],
  ['a very long valid-looking prefix', `0.73.0${'0'.repeat(100_000)}`],
  ['a very long string', 'a'.repeat(1_000_000)],
  ['prototype key', '__proto__'],
  ['the invalid sentinel itself', 'invalid'],
  ['the unknown sentinel sent as a string', 'unknown'],
];

/** Every label the function is allowed to return, built without calling it. */
function allowedLabels(): Set<string> {
  const labels = new Set<string>(['unknown', 'invalid']);
  for (let minor = 0; minor <= 149; minor++) labels.add(`0.${minor}`);
  return labels;
}

describe('sdkVersionLabel', () => {
  it('reduces a plain semver to major.minor', () => {
    expect(sdkVersionLabel('0.73.0')).toBe('0.73');
    expect(sdkVersionLabel('0.73.12')).toBe('0.73');
    expect(sdkVersionLabel('0.0.0')).toBe('0.0');
    expect(sdkVersionLabel('0.4.999999')).toBe('0.4');
  });

  it('accepts exactly up to the ceilings', () => {
    expect(sdkVersionLabel('0.149.0')).toBe('0.149');
    expect(sdkVersionLabel('0.150.0')).toBe('invalid');
    expect(sdkVersionLabel('1.0.0')).toBe('invalid');
    expect(sdkVersionLabel('1.73.0')).toBe('invalid');
  });

  it('maps an absent value to unknown, and only an absent value', () => {
    expect(sdkVersionLabel(undefined)).toBe('unknown');
    expect(sdkVersionLabel(null)).toBe('invalid');
    expect(sdkVersionLabel('')).toBe('invalid');
  });

  it.each(HOSTILE)('maps %s to invalid', (_name, value) => {
    expect(sdkVersionLabel(value)).toBe('invalid');
  });

  it('states its own label count as 152', () => {
    expect(SDK_VERSION_LABEL_COUNT).toBe(152);
  });

  it('returns every in-range version as its own label and nothing outside the closed set', () => {
    const allowed = allowedLabels();
    const seen = new Set<string>();
    // A grid that overshoots both ceilings, so the out-of-range half is exercised too.
    for (let major = 0; major <= 12; major++) {
      for (let minor = 0; minor <= 1100; minor++) {
        seen.add(sdkVersionLabel(`${major}.${minor}.0`));
        seen.add(sdkVersionLabel(`${major}.${minor}.7`));
      }
    }
    for (const [, value] of HOSTILE) seen.add(sdkVersionLabel(value));
    seen.add(sdkVersionLabel(undefined));

    for (const label of seen) expect(allowed.has(label), label).toBe(true);
    // The grid covers the whole range, so every allowed label was produced.
    expect(seen.size).toBe(152);
  });

  it('never throws', () => {
    for (const [, value] of HOSTILE) expect(() => sdkVersionLabel(value)).not.toThrow();
  });
});

// Everything `sdkNameLabel` must refuse to return as a name.
const HOSTILE_NAMES: Array<[string, unknown]> = [
  ['null', null],
  ['empty string', ''],
  ['a number', 1],
  ['a boolean', true],
  ['an array holding a valid name', ['sdk']],
  ['an object', { name: 'sdk' }],
  ['an object with toString', { toString: () => 'sdk' }],
  ['a String object', new String('sdk')],
  ['a symbol', Symbol('sdk')],
  ['different case', 'SDK'],
  ['mixed case', 'Blocks-React'],
  ['the scoped package name', '@civitai/blocks-react'],
  ['the other scoped package name', '@civitai/sdk'],
  ['an underscore variant', 'blocks_react'],
  ['leading whitespace', ' sdk'],
  ['trailing whitespace', 'sdk '],
  ['trailing newline', 'blocks-react\n'],
  ['NUL byte', 'sdk\u0000'],
  ['a name with a suffix', 'sdk-next'],
  ['both names', 'blocks-react,sdk'],
  ['a third package', 'app-sdk'],
  ['a prototype key', 'constructor'],
  ['__proto__', '__proto__'],
  ['the unknown sentinel sent as a string', 'unknown'],
  ['a label-injection attempt', 'sdk",host="x'],
  ['a very long string', 's'.repeat(1_000_000)],
];

describe('sdkNameLabel', () => {
  it('keeps exactly the two package names', () => {
    expect(sdkNameLabel('blocks-react')).toBe('blocks-react');
    expect(sdkNameLabel('sdk')).toBe('sdk');
    expect([...SDK_NAMES]).toEqual(['blocks-react', 'sdk']);
  });

  it('maps an absent value to unknown', () => {
    expect(sdkNameLabel(undefined)).toBe('unknown');
  });

  it.each(HOSTILE_NAMES)('maps %s to unknown', (_name, value) => {
    expect(sdkNameLabel(value)).toBe('unknown');
  });

  it('can return only three values', () => {
    const seen = new Set<string>([
      sdkNameLabel(undefined),
      sdkNameLabel('sdk'),
      sdkNameLabel('blocks-react'),
    ]);
    for (const [, value] of HOSTILE_NAMES) seen.add(sdkNameLabel(value));
    for (const [, value] of HOSTILE) seen.add(sdkNameLabel(value));
    expect([...seen].sort()).toEqual(['blocks-react', 'sdk', 'unknown']);
  });
});

describe('readBlockReadySdk', () => {
  it('returns nothing when the payload reports nothing', () => {
    for (const payload of [{}, { height: 640 }, { sdkVersion: undefined }, undefined, null, 73])
      expect(readBlockReadySdk(payload)).toEqual({});
    expect(readBlockReadySdk('0.73.0')).toEqual({});
    expect(hasBlockReadySdk(readBlockReadySdk({ height: 640 }))).toBe(false);
  });

  it('passes an accepted version and name through unchanged', () => {
    expect(
      readBlockReadySdk({ height: 640, sdkVersion: '0.73.0', sdkName: 'blocks-react' })
    ).toEqual({ sdkVersion: '0.73.0', sdkName: 'blocks-react' });
    expect(readBlockReadySdk({ sdkVersion: '0.2.345', sdkName: 'sdk' })).toEqual({
      sdkVersion: '0.2.345',
      sdkName: 'sdk',
    });
  });

  it('reads the two fields independently', () => {
    expect(readBlockReadySdk({ sdkVersion: '0.73.0' })).toEqual({ sdkVersion: '0.73.0' });
    expect(readBlockReadySdk({ sdkName: 'sdk' })).toEqual({ sdkName: 'sdk' });
    expect(readBlockReadySdk({ sdkVersion: 'nope', sdkName: 'sdk' })).toEqual({
      sdkVersion: 'invalid',
      sdkName: 'sdk',
    });
    expect(readBlockReadySdk({ sdkVersion: '0.73.0', sdkName: 'nope' })).toEqual({
      sdkVersion: '0.73.0',
    });
    expect(hasBlockReadySdk({ sdkName: 'sdk' })).toBe(true);
    expect(hasBlockReadySdk({ sdkVersion: 'invalid' })).toBe(true);
  });

  it.each(HOSTILE)('replaces the version %s with the invalid sentinel', (_name, value) => {
    expect(readBlockReadySdk({ sdkVersion: value })).toEqual({ sdkVersion: 'invalid' });
  });

  it.each(HOSTILE_NAMES)('drops the name %s', (_name, value) => {
    expect(readBlockReadySdk({ sdkName: value })).toEqual({});
  });

  it('never forwards a block-supplied string longer than 12 characters', () => {
    for (const [, version] of HOSTILE)
      for (const [, name] of HOSTILE_NAMES.slice(0, 6)) {
        const out = readBlockReadySdk({ sdkVersion: version, sdkName: name });
        expect(Object.keys(out)).toEqual(['sdkVersion']);
        expect((out.sdkVersion as string).length).toBeLessThanOrEqual(12);
      }
    expect(readBlockReadySdk({ sdkVersion: '0.149.999999' }).sdkVersion).toBe('0.149.999999');
  });

  it('survives a payload whose property access throws', () => {
    const payload = Object.defineProperty({ sdkName: 'sdk' }, 'sdkVersion', {
      get() {
        throw new Error('hostile getter');
      },
    });
    expect(() => readBlockReadySdk(payload)).not.toThrow();
    expect(readBlockReadySdk(payload)).toEqual({});
  });
});
