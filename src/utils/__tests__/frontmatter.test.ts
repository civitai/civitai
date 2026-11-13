import { describe, expect, test } from 'vitest';
import { parseFrontmatter } from '~/utils/frontmatter';

describe('parseFrontmatter', () => {
  test('splits the YAML block from the body', () => {
    expect(parseFrontmatter('---\ntitle: Terms\nlastmod: x\n---\n# Body\n')).toEqual({
      data: { title: 'Terms', lastmod: 'x' },
      content: '# Body\n',
    });
  });

  test('handles a BOM, CRLF line endings and an empty block', () => {
    expect(parseFrontmatter('﻿---\r\na: 1\r\n---\r\nbody')).toEqual({
      data: { a: 1 },
      content: 'body',
    });
    expect(parseFrontmatter('---\n---\nbody')).toEqual({ data: {}, content: 'body' });
  });

  test('leaves a document without a leading block untouched', () => {
    const doc = 'intro\n---\na: 1\n---\n';
    expect(parseFrontmatter(doc)).toEqual({ data: {}, content: doc });
  });
});
