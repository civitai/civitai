import { describe, expect, it, vi } from 'vitest';
import type * as Crypto from 'node:crypto';

const { randomBytes } = vi.hoisted(() => ({ randomBytes: vi.fn() }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof Crypto>();
  randomBytes.mockImplementation(actual.randomBytes as never);
  return { ...actual, randomBytes };
});

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
/** 16 random bytes as hex: no two uploads of one name should ever share a key. */
const UPLOAD_KEY_SHAPE = /^model\/42\/[A-Za-z0-9_]+\.[0-9a-f]{32}\.safetensors$/;

describe('buildUploadKey', () => {
  it('puts the userId in segment 1, where sign-part authorises against it', () => {
    const key = buildUploadKey('model', 42, 'thing.safetensors');
    expect(key.split('/')[0]).toBe('model');
    expect(key.split('/')[1]).toBe('42');
  });

  it('sanitises the filename and appends a 128-bit random token', () => {
    expect(buildUploadKey('model', 42, 'My Model v1.0.safetensors')).toMatch(UPLOAD_KEY_SHAPE);
  });

  it('takes its token from the system CSPRNG', () => {
    const bytes = Buffer.alloc(16, 0xab);
    randomBytes.mockReturnValueOnce(bytes as never);

    expect(buildUploadKey('model', 42, 'a.safetensors')).toBe(
      `model/42/a.${bytes.toString('hex')}.safetensors`
    );
    expect(randomBytes).toHaveBeenCalledWith(16);
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
