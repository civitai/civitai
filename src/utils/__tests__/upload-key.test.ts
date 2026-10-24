import { describe, expect, it } from 'vitest';

import { buildUploadKey } from '~/utils/upload-key';

/**
 * `buildUploadKey` is the only sanitiser applied to a client-supplied filename on `/api/upload`, and
 * the shape it produces is an authorisation contract: `/api/upload/sign-part` authorises a part by
 * comparing `key.split('/')[1]` to the session's user id.
 *
 * The endpoint's own suite asserts the key as `expect.any(String)`, so before this file existed both
 * the collision token and the sanitiser could be deleted with every test still green — which in
 * production is one upload silently overwriting another's object.
 */
describe('buildUploadKey', () => {
  it('puts the userId in segment 1, where sign-part authorises against it', () => {
    const key = buildUploadKey('model', 42, 'thing.safetensors');
    expect(key.split('/')[0]).toBe('model');
    expect(key.split('/')[1]).toBe('42');
  });

  it('sanitises the filename and appends a collision token', () => {
    expect(buildUploadKey('model', 42, 'My Model v1.0.safetensors')).toMatch(
      /^model\/42\/[A-Za-z0-9_]+\.[A-Za-z0-9]{4}\.safetensors$/
    );
  });

  it('gives two uploads of the same filename different keys', () => {
    const a = buildUploadKey('model', 42, 'model.safetensors');
    const b = buildUploadKey('model', 42, 'model.safetensors');
    // Without the token these collide, and the second upload overwrites the first object while every
    // ModelFile.url already pointing at it silently starts serving different bytes.
    expect(a).not.toBe(b);
  });

  it('cannot be made to add path segments from the filename', () => {
    const key = buildUploadKey('model', 42, '../../etc/pass wd.safetensors');
    expect(key.split('/')).toHaveLength(3);
    expect(key.split('/')[1]).toBe('42');
  });

  it('keeps an extensionless filename in one segment', () => {
    const key = buildUploadKey('default', 7, 'README');
    expect(key.split('/')).toHaveLength(3);
    expect(key.startsWith('default/7/')).toBe(true);
  });
});
