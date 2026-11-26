import { describe, expect, it } from 'vitest';
import {
  onBehalfVersion,
  planOnBehalfFiles,
  withManifestVersion,
} from '~/server/services/blocks/app-platform-update-submit.plan';
import { gitBlobSha } from '~/server/services/blocks/app-source-repo.plan';

/** The bundle and version a staff on-behalf submit files, as literals. */

const b = (s: string) => Buffer.from(s);
const text = (m: Map<string, Buffer>) =>
  Object.fromEntries([...m].map(([k, v]) => [k, v.toString('utf8')]));

describe('planOnBehalfFiles', () => {
  const approved = new Map([
    ['index.html', b('<p>approved</p>')],
    ['package.json', b('{"v":"old"}')],
    ['legacy.js', b('old()')],
  ]);

  it('applies every path of the update to the approved build, keeping the rest', () => {
    const files = planOnBehalfFiles({
      approved,
      // The update's base holds what the approved build holds at the paths it changes, plus the
      // owner's unsubmitted work elsewhere (wip.ts), which must not reach the bundle.
      baseTree: {
        'package.json': gitBlobSha(b('{"v":"old"}')),
        'legacy.js': gitBlobSha(b('old()')),
        'wip.ts': gitBlobSha(b('unsubmitted')),
      },
      paths: [
        { path: 'package.json', operation: 'update' },
        { path: 'src/shim.ts', operation: 'create' },
        { path: 'legacy.js', operation: 'delete' },
      ],
      updateFiles: new Map([
        ['package.json', b('{"v":"new"}')],
        ['src/shim.ts', b('export {};')],
      ]),
    });
    expect(text(files)).toEqual({
      'index.html': '<p>approved</p>',
      'package.json': '{"v":"new"}',
      'src/shim.ts': 'export {};',
    });
  });

  it('refuses a path where the approved build differs from the update’s base, naming each', () => {
    expect(() =>
      planOnBehalfFiles({
        approved,
        baseTree: {
          'package.json': gitBlobSha(b('{"v":"owner-edit"}')),
          // Created by the update, but the approved build already holds one: also a conflict.
        },
        paths: [
          { path: 'package.json', operation: 'update' },
          { path: 'index.html', operation: 'create' },
        ],
        updateFiles: new Map([
          ['package.json', b('{"v":"new"}')],
          ['index.html', b('<p>new</p>')],
        ]),
      })
    ).toThrow(
      'The approved version differs from what the update was written against in index.html, ' +
        'package.json; the owner has to merge this update and submit it themselves'
    );
  });
});

describe('onBehalfVersion', () => {
  it('the patch after the highest approved version when the manifest is not above it', () => {
    expect(onBehalfVersion('1.4.0', ['1.2.0', '1.10.3', '1.4.0'])).toBe('1.10.4');
    expect(onBehalfVersion('0.9.0', ['1.2.0'])).toBe('1.2.1');
  });

  it('the manifest’s own version when it is above every approved one', () => {
    expect(onBehalfVersion('2.0.0', ['1.2.0', '1.10.3'])).toBe('2.0.0');
  });
});

describe('withManifestVersion', () => {
  it('rewrites only the version, and leaves the bytes alone when it already matches', () => {
    const file = b('{"blockId":"pixel-garden","version":"1.2.0","name":"Pixel"}');
    expect(withManifestVersion(file, '1.2.1').toString('utf8')).toBe(
      '{\n  "blockId": "pixel-garden",\n  "version": "1.2.1",\n  "name": "Pixel"\n}\n'
    );
    expect(withManifestVersion(file, '1.2.0')).toBe(file);
  });
});
