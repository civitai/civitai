import { describe, expect, it } from 'vitest';
import {
  checkMediaFile,
  MEDIA_UPLOAD_MAX_BYTES,
  processMediaUploadBytes,
  resolveMediaUploadRequest,
  sniffMediaType,
  type MediaUploadKind,
} from '~/components/AppBlocks/mediaUploadLogic';
import type { SaveBytesWindowEntry } from '~/components/AppBlocks/saveImageDownload';

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const buf = (head: number[], size = 64) => {
  const u8 = new Uint8Array(Math.max(size, head.length));
  u8.set(head);
  return u8.buffer;
};

const HEADS = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d],
  jpeg: [0xff, 0xd8, 0xff, 0xe0, 0, 0x10],
  webp: [...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEBPVP8 ')],
  gif: ascii('GIF89a'),
  mp4: [0, 0, 0, 0x18, ...ascii('ftypisom'), 0, 0, 2, 0],
  webm: [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, ...ascii('webm')],
  mkv: [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88, ...ascii('matroska')],
  id3: [...ascii('ID3'), 4, 0, 0, 0, 0, 0, 0],
  mp3Frame: [0xff, 0xfb, 0x90, 0x64],
  aacAdts: [0xff, 0xf1, 0x50, 0x80],
  mp3ReservedVersion: [0xff, 0xeb, 0x90, 0x64],
  wav: [...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WAVEfmt ')],
};

describe('sniffMediaType', () => {
  const cases: Array<[MediaUploadKind, keyof typeof HEADS, string | null]> = [
    ['image', 'png', 'image/png'],
    ['image', 'jpeg', 'image/jpeg'],
    ['image', 'webp', 'image/webp'],
    ['image', 'gif', null],
    ['image', 'mp4', null],
    ['video', 'mp4', 'video/mp4'],
    ['video', 'webm', 'video/webm'],
    ['video', 'mkv', null],
    ['video', 'png', null],
    ['video', 'wav', null],
    ['audio', 'webm', 'audio/webm'],
    ['audio', 'wav', 'audio/wav'],
    ['audio', 'id3', 'audio/mpeg'],
    ['audio', 'mp3Frame', 'audio/mpeg'],
    ['audio', 'aacAdts', null],
    ['audio', 'mp3ReservedVersion', null],
    ['audio', 'mkv', null],
    ['audio', 'png', null],
    ['audio', 'mp4', null],
    ['audio', 'webp', null],
  ];
  it.each(cases)('%s + %s → %s', (kind, head, expected) => {
    expect(sniffMediaType(kind, buf(HEADS[head]))).toBe(expected);
  });

  it('only finds the WebM DocType within the first 64 bytes', () => {
    const late = new Uint8Array(200);
    late.set(HEADS.mkv);
    late.set(ascii('webm'), 100);
    expect(sniffMediaType('video', late.buffer)).toBeNull();
  });
});

describe('resolveMediaUploadRequest', () => {
  const ok = { requestId: 'rq_1', kind: 'video', purpose: 'generationSource' };

  it('drops a payload with no usable requestId', () => {
    for (const raw of [null, 'x', {}, { ...ok, requestId: '' }, { ...ok, requestId: 7 }]) {
      expect(resolveMediaUploadRequest(raw)).toEqual({ kind: 'drop' });
    }
  });

  it('accepts a picker request and a bytes request', () => {
    expect(resolveMediaUploadRequest(ok)).toEqual({
      kind: 'ok',
      request: { requestId: 'rq_1', kind: 'video' },
    });
    const bytes = buf(HEADS.webm);
    expect(resolveMediaUploadRequest({ ...ok, bytes, mimeType: 'video/webm' })).toEqual({
      kind: 'ok',
      request: { requestId: 'rq_1', kind: 'video', bytes, mimeType: 'video/webm' },
    });
  });

  it.each([
    [{ ...ok, kind: 'document' }, "kind must be 'image', 'video' or 'audio'"],
    [{ ...ok, kind: undefined }, "kind must be 'image', 'video' or 'audio'"],
    [{ ...ok, purpose: undefined }, "purpose must be 'generationSource'"],
    [{ ...ok, purpose: 'display' }, "purpose must be 'generationSource'"],
    [{ ...ok, bytes: new Uint8Array(HEADS.webm) }, 'invalid media-upload request'],
    [{ ...ok, bytes: new ArrayBuffer(0) }, 'invalid media-upload request'],
    [{ ...ok, bytes: 'AAAA' }, 'invalid media-upload request'],
    [{ ...ok, bytes: buf(HEADS.webm), mimeType: 5 }, 'invalid media-upload request'],
  ])('refuses %o', (raw, error) => {
    expect(resolveMediaUploadRequest(raw)).toEqual({ kind: 'refuse', requestId: 'rq_1', error });
  });
});

describe('checkMediaFile (the picked-file path)', () => {
  // Literal sizes, not the constants, so a changed cap cannot move both sides of the test.
  const MB = 1024 * 1024;
  it.each([
    ['video', HEADS.mp4, 64 * MB, 'file exceeds the 64 MB upload limit'],
    ['audio', HEADS.wav, 64 * MB, 'file exceeds the 64 MB upload limit'],
    ['image', HEADS.png, 24 * MB, 'file exceeds the 24 MB image upload limit'],
  ] as const)('caps %s at its limit', (kind, head, cap, error) => {
    expect(checkMediaFile(kind, cap + 1, buf([...head]))).toEqual({ ok: false, error });
    expect(checkMediaFile(kind, cap, buf([...head])).ok).toBe(true);
  });
});

describe('processMediaUploadBytes', () => {
  const T0 = 1_000_000;
  const run = (
    req: { kind: MediaUploadKind; bytes: ArrayBuffer; mimeType?: string },
    recent: SaveBytesWindowEntry[] = [],
    now = T0
  ) => processMediaUploadBytes(req, recent, now);

  it.each([
    ['image', 'images must be PNG, JPEG or WebP', HEADS.gif],
    ['video', 'videos must be MP4 or WebM', HEADS.wav],
    ['audio', 'audio must be MP3, WAV or WebM', HEADS.png],
  ] as const)('refuses the wrong content for %s with its own message', (kind, error, head) => {
    const out = run({ kind, bytes: buf([...head]) });
    expect(out.result).toEqual({ ok: false, error });
    expect(out.recent).toEqual([]);
  });

  it.each([
    ['image', HEADS.webp, 'image/webp', 301],
    ['video', HEADS.webm, 'video/webm', 302],
    ['audio', HEADS.wav, 'audio/wav', 303],
  ] as const)('admits %s and records it', (kind, head, contentType, size) => {
    const out = run({ kind, bytes: buf([...head], size) });
    expect(out.result).toEqual({ ok: true, contentType });
    expect(out.recent).toEqual([{ at: T0, size }]);
  });

  it('refuses an over-cap file as too large, even when the window is also full', () => {
    const over = buf(HEADS.mp4, MEDIA_UPLOAD_MAX_BYTES + 1);
    const full = Array.from({ length: 8 }, () => ({ at: T0, size: 1 }));
    expect(run({ kind: 'video', bytes: over }, full).result).toEqual({
      ok: false,
      error: 'file exceeds the 64 MB upload limit',
    });
    expect(run({ kind: 'video', bytes: buf(HEADS.mp4, MEDIA_UPLOAD_MAX_BYTES) }).result).toEqual({
      ok: true,
      contentType: 'video/mp4',
    });
  });

  it('checks a declared mimeType against the content', () => {
    const wav = buf(HEADS.wav);
    expect(run({ kind: 'audio', bytes: wav, mimeType: 'audio/mpeg' }).result).toEqual({
      ok: false,
      error: "mimeType does not match the file's content",
    });
    expect(run({ kind: 'audio', bytes: wav, mimeType: 'audio/x-wav' }).result.ok).toBe(true);
    expect(
      run({ kind: 'video', bytes: buf(HEADS.webm), mimeType: 'Video/WebM; codecs=vp9' }).result.ok
    ).toBe(true);
  });

  it('admits 8 uploads per 60 s, refuses the 9th as busy, and frees the window after 60 s', () => {
    let recent: SaveBytesWindowEntry[] = [];
    for (let i = 0; i < 8; i++) {
      const out = run({ kind: 'image', bytes: buf(HEADS.png, 100 + i) }, recent, T0 + i);
      expect(out.result.ok, `upload ${i + 1}`).toBe(true);
      recent = out.recent;
    }
    expect(run({ kind: 'image', bytes: buf(HEADS.png) }, recent, T0 + 59_999).result).toEqual({
      ok: false,
      error: 'busy',
    });
    expect(run({ kind: 'image', bytes: buf(HEADS.png) }, recent, T0 + 60_000).result.ok).toBe(true);
  });

  it('does not record a refused upload', () => {
    let recent: SaveBytesWindowEntry[] = [];
    for (let i = 0; i < 7; i++) {
      recent = run({ kind: 'audio', bytes: buf(HEADS.id3) }, recent, T0 + i).recent;
    }
    recent = run({ kind: 'audio', bytes: buf(HEADS.gif) }, recent, T0 + 7).recent;
    recent = run(
      { kind: 'audio', bytes: buf(HEADS.wav), mimeType: 'audio/webm' },
      recent,
      T0 + 8
    ).recent;
    expect(recent).toHaveLength(7);
    expect(run({ kind: 'audio', bytes: buf(HEADS.wav) }, recent, T0 + 9).result.ok).toBe(true);
  });

  it('holds at most two max-size files per window', () => {
    const big = () => buf(HEADS.mp4, MEDIA_UPLOAD_MAX_BYTES);
    let recent = run({ kind: 'video', bytes: big() }).recent;
    recent = run({ kind: 'video', bytes: big() }, recent).recent;
    expect(recent).toHaveLength(2);
    expect(run({ kind: 'video', bytes: buf(HEADS.mp4, 12) }, recent).result).toEqual({
      ok: false,
      error: 'busy',
    });
  });
});
