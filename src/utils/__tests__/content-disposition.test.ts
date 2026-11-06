import { describe, expect, it } from 'vitest';

import { attachmentContentDisposition } from '~/utils/content-disposition';

/** The quoted `filename` value, read the way a browser reads it: up to the first bare quote. */
function quotedFilename(header: string) {
  return header.match(/filename="([^"]*)"/)?.[1];
}

describe('attachmentContentDisposition', () => {
  it('keeps a plain name in both forms', () => {
    expect(attachmentContentDisposition('bbBunny_v1.safetensors')).toBe(
      `attachment; filename="bbBunny_v1.safetensors"; filename*=UTF-8''bbBunny_v1.safetensors`
    );
  });

  it('cannot be split into a second header line by CR/LF', () => {
    const header = attachmentContentDisposition('a.safetensors\r\nSet-Cookie: x=1');
    // filename* is percent-decoded by the browser, so an encoded CR/LF would come back.
    expect(header).not.toMatch(/%0[DA]/i);
    expect(quotedFilename(header)).toBe('a.safetensorsSet-Cookie: x=1');
  });

  it('cannot close the quoted string early', () => {
    const header = attachmentContentDisposition('a"; filename="evil.exe');
    expect(quotedFilename(header)).toBe('a_; filename=_evil.exe');
    expect(header.match(/filename="/g)).toHaveLength(1);
  });

  it('cannot escape the closing quote with a backslash', () => {
    // In a quoted-string `\"` is an escaped quote, so a trailing backslash would swallow the close.
    const header = attachmentContentDisposition('a.safetensors\\');
    expect(quotedFilename(header)).toBe('a.safetensors_');
    expect(header).toContain('filename="a.safetensors_"; ');
  });

  it('carries a non-ASCII name in filename* (RFC 5987) and an ASCII fallback in filename', () => {
    const header = attachmentContentDisposition("キュア (v1)'s.safetensors");
    expect(quotedFilename(header)).toBe("___ (v1)'s.safetensors");
    const encoded = header.split("filename*=UTF-8''")[1];
    expect(encoded).toBe('%E3%82%AD%E3%83%A5%E3%82%A2%20%28v1%29%27s.safetensors');
    expect(decodeURIComponent(encoded)).toBe("キュア (v1)'s.safetensors");
  });
});
