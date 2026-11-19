import { describe, expect, it } from 'vitest';
import { blobExtension } from '~/utils/file-utils';

const blob = (type: string) => new Blob([''], { type });

describe('blobExtension', () => {
  it('names an SVG download .svg, not .svg+xml', () => {
    expect(blobExtension(blob('image/svg+xml'), 'bin')).toBe('svg');
  });

  it('keeps gif and maps jpeg to jpg', () => {
    expect(blobExtension(blob('image/gif'), 'bin')).toBe('gif');
    expect(blobExtension(blob('image/jpeg'), 'bin')).toBe('jpg');
  });

  it('falls back when the server sends no usable type', () => {
    expect(blobExtension(blob('application/octet-stream'), 'png')).toBe('png');
    expect(blobExtension(blob(''), 'png')).toBe('png');
  });
});
