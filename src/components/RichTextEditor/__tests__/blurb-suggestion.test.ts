import { generateHTML } from '@tiptap/html';
import type { ResolvedPos } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import { findSuggestionMatch } from '@tiptap/suggestion';
import { describe, expect, it } from 'vitest';
import { createBlurbSuggestion } from '~/components/RichTextEditor/blurb-suggestion';
import type { BlurbItem } from '~/components/RichTextEditor/blurb.util';
import { BlurbNode } from '~/shared/tiptap/blurb.node';

const { suggestion } = createBlurbSuggestion({ getItems: () => [] });

/**
 * Runs the plugin's own trigger config through the plugin's own matcher, so the assertions move
 * with `char` / `allowSpaces` / `allowedPrefixes` rather than restating them. `findSuggestionMatch`
 * reads nothing off the resolved position but `pos` and `nodeBefore`.
 */
function matchAtEndOf(text: string) {
  return findSuggestionMatch({
    char: suggestion.char as string,
    allowSpaces: suggestion.allowSpaces ?? false,
    allowToIncludeChar: false,
    allowedPrefixes: suggestion.allowedPrefixes ?? [' '],
    startOfLine: suggestion.startOfLine ?? false,
    $position: {
      pos: text.length + 1,
      nodeBefore: { isText: true, text },
    } as unknown as ResolvedPos,
  });
}

describe('createBlurbSuggestion', () => {
  it('opens at the start of an input', () => {
    expect(matchAtEndOf('//')?.query).toBe('');
  });

  it('opens after whitespace and carries the typed query', () => {
    expect(matchAtEndOf('thanks //sup')?.query).toBe('sup');
  });

  it('🔴 does not open inside an https:// URL', () => {
    expect(matchAtEndOf('see https://')).toBeNull();
    expect(matchAtEndOf('see https://example')).toBeNull();
  });

  it('does not open mid-word', () => {
    expect(matchAtEndOf('foo//')).toBeNull();
  });

  it('does not open on a lone slash', () => {
    expect(matchAtEndOf('and /')).toBeNull();
    expect(matchAtEndOf('/')).toBeNull();
  });

  it('inserts attrs the blurb node renders as a materialised span', () => {
    const blurb: BlurbItem = {
      id: 7,
      name: 'support-footer',
      content: 'Tip me: ko-fi.com/example',
      referenceCount: 41,
      referencesByEntityType: { Model: 41 },
    };

    let inserted: unknown;
    const chain = {
      focus: () => chain,
      deleteRange: () => chain,
      insertContent: (content: unknown) => {
        inserted = content;
        return chain;
      },
      run: () => true,
    };

    suggestion.command?.({
      editor: { chain: () => chain } as never,
      range: { from: 1, to: 3 },
      props: blurb,
    });

    const html = generateHTML(
      { type: 'doc', content: [{ type: 'paragraph', content: [inserted] }] },
      [StarterKit.configure({ heading: false }), BlurbNode]
    );

    expect(html).toContain('<span data-type="blurb" data-id="7">Tip me: ko-fi.com/example</span>');
  });
});
