import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

import { parseImageRef } from '../image-ref';

describe('parseImageRef', () => {
  it.each([
    ['123', 123],
    ['  45  ', 45],
    ['https://civitai.com/images/123', 123],
    ['https://civitai.com/images/123?postId=5', 123],
    ['https://civitai.com/images/123/', 123],
    ['https://civitai.red/images/9#comments', 9],
  ])('reads %s as image %i', (text, id) => {
    expect(parseImageRef(text)).toBe(id);
  });

  it.each([
    '',
    'abc',
    '0',
    '-3',
    '2147483648',
    'https://civitai.com/models/12',
    'https://civitai.com/images/12x',
  ])('reads %j as no image', (text) => {
    expect(parseImageRef(text)).toBeNull();
  });
});
