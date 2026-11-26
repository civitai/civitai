import { describe, expect, it } from 'vitest';
import { commentContentSchema } from '~/server/schema/commentv3.schema';
import { fpHtmlToText, fpTextToHtml } from '~/server/services/feature-pages/comment-text';

describe('Feature Pages comment text', () => {
  it.each([
    'plain',
    'two\nlines',
    `<script>alert("x")</script> & 'quotes' &amp; already`,
    'a <b>tag</b> stays text',
    'trailing\n',
  ])('round-trips %j through the stored, sanitized HTML unchanged', (text) => {
    const stored = commentContentSchema.parse(fpTextToHtml(text));
    expect(stored).not.toContain('<script');
    expect(stored).not.toContain('<b>');
    expect(fpHtmlToText(stored)).toBe(text);
  });
});
