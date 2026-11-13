import { describe, expect, it } from 'vitest';
import { citationsIn, renderAnswer, unverifiedCitations } from '../answer';

/**
 * The answer is model output that can quote user-written text and is rendered with `{@html}`, so the
 * one thing this module must never do is let markup through. And a citation becomes a link only when
 * a tool returned that record in this chat.
 */

const source = { ref: 'user:5', href: '/retool/user-lookup?q=5', label: 'five' };

describe('renderAnswer', () => {
  it('escapes markup in the answer, including inside quoted user text', () => {
    const html = renderAnswer(
      'Bio says ⟦<img src=x onerror=alert(1)>⟧ and <script>x()</script>',
      []
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('links a citation a tool returned, and only that', () => {
    const html = renderAnswer('Linked to [user:5] and [user:6].', [source]);
    expect(html).toContain('<a class="cite" href="/retool/user-lookup?q=5"');
    expect(html).toContain('>user:5</a>');
    expect(html).not.toMatch(/href="[^"]*6/);
    expect(html).toContain('<span class="cite-unverified"');
  });

  it('refuses a source href that is not an app path', () => {
    for (const href of ['javascript:alert(1)', '//evil.example/x', 'https://evil.example']) {
      const html = renderAnswer('[user:5]', [{ ...source, href }]);
      expect(html).not.toContain('<a');
    }
  });

  it('copies a fenced block verbatim, escaped and without links', () => {
    const html = renderAnswer('Candidates:\n```\n5\n[user:5]\n<b>\n```', [source]);
    expect(html).toContain('<pre><code>5\n[user:5]\n&lt;b&gt;</code></pre>');
    expect(html).not.toContain('<a');
  });

  it('renders lists, headings and bold', () => {
    expect(renderAnswer('# Verdict\n- **one**\n- two\n\n1. a\n2. b', [])).toBe(
      '<h4>Verdict</h4><ul><li><strong>one</strong></li><li>two</li></ul><ol><li>a</li><li>b</li></ol>'
    );
  });
});

describe('citations', () => {
  it('finds each citation once and ignores look-alikes', () => {
    expect(citationsIn('[user:1] [user:1] [report:22] [User:3] [user:abc] [email:4]')).toEqual([
      'user:1',
      'report:22',
    ]);
  });

  it('reports the ones no tool returned', () => {
    expect(unverifiedCitations('[user:1] [user:2] [run:3]', ['user:1', 'run:3'])).toEqual([
      'user:2',
    ]);
  });
});
