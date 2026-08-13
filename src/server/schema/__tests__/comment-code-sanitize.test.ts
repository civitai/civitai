import { describe, expect, it } from 'vitest';
import { commentUpsertInput } from '~/server/schema/comment.schema';
import { upsertCommentv2Schema } from '~/server/schema/commentv2.schema';

/**
 * The comment editor ships the code-block control and StarterKit's inline `code`
 * mark, so anything the toolbar can produce has to survive the save-side
 * allowlist. It didn't: `code`/`pre` were missing from both comment schemas while
 * every comparable surface allowed them, and a marked prompt snippet came back as
 * plain body copy (Freshdesk #69083).
 */
const surfaces = [
  [
    'commentv2',
    (content: string) =>
      upsertCommentv2Schema.parse({ entityType: 'model', entityId: 1, content }).content,
  ],
  ['model comment', (content: string) => commentUpsertInput.parse({ modelId: 1, content }).content],
] as const;

describe.each(surfaces)('%s sanitization', (_label, parse) => {
  it('keeps inline code', () => {
    expect(parse('<p>use <code>score_8, score_7</code> in the prompt</p>')).toContain(
      '<code>score_8, score_7</code>'
    );
  });

  it('keeps code blocks', () => {
    const clean = parse('<pre><code>highres, score_8, score_7</code></pre>');
    expect(clean).toContain('<pre>');
    expect(clean).toContain('highres, score_8, score_7');
  });

  it('still strips img — the list stays narrower than the default', () => {
    expect(parse('<p>look <img src="https://example.com/x.png" /></p>')).not.toContain('<img');
  });

  it('still keeps sticker spans', () => {
    expect(parse('<p><span data-type="sticker" data-id="12"></span></p>')).toContain(
      'data-type="sticker"'
    );
  });
});
