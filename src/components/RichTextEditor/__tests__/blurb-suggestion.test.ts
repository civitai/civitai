// @vitest-environment happy-dom
import type { ResolvedPos } from '@tiptap/pm/model';
import { findSuggestionMatch } from '@tiptap/suggestion';
import { describe, expect, it, vi } from 'vitest';
import { createBlurbSuggestion } from '~/components/RichTextEditor/blurb-suggestion';
import type { BlurbItem } from '~/components/RichTextEditor/blurb.util';

const blurb: BlurbItem = {
  id: 7,
  name: 'support-footer',
  content: 'Tip me: ko-fi.com/example',
  referenceCount: 41,
  referencesByEntityType: { Model: 41 },
};

function makeChain() {
  const calls: { deleteRange: { from: number; to: number }[]; insertContent: unknown[] } = {
    deleteRange: [],
    insertContent: [],
  };
  const chain = {
    focus: () => chain,
    deleteRange: (range: { from: number; to: number }) => {
      calls.deleteRange.push(range);
      return chain;
    },
    insertContent: (content: unknown) => {
      calls.insertContent.push(content);
      return chain;
    },
    run: () => true,
  };
  return { chain, calls };
}

const { suggestion } = createBlurbSuggestion({ getItems: () => [] });

/**
 * Runs the plugin's own trigger config through the plugin's own matcher. `char` and `allowSpaces`
 * are read off the factory so a revert fails here; the other three are the plugin's documented
 * defaults, pinned as unset by the test below — supplying `?? [' ']` fallbacks instead would let
 * `allowedPrefixes: null` (tiptap's "fire anywhere") break `https://` while the suite stayed green.
 * `findSuggestionMatch` reads nothing off the resolved position but `pos` and `nodeBefore`.
 */
function matchAtEndOf(text: string) {
  return findSuggestionMatch({
    char: suggestion.char as string,
    allowSpaces: suggestion.allowSpaces as boolean,
    allowToIncludeChar: false,
    allowedPrefixes: [' '],
    startOfLine: false,
    $position: {
      pos: text.length + 1,
      nodeBefore: { isText: true, text },
    } as unknown as ResolvedPos,
  });
}

describe('createBlurbSuggestion', () => {
  it('🔴 leaves the prefix options unset so the plugin defaults apply', () => {
    expect(suggestion).not.toHaveProperty('allowedPrefixes');
    expect(suggestion).not.toHaveProperty('startOfLine');
    expect(suggestion).not.toHaveProperty('allowToIncludeChar');
    expect(suggestion.char).toBe('//');
    expect(suggestion.allowSpaces).toBe(false);
  });

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

  // What the inserted content must be is pinned in blurb.util.test.ts, against the real node.
  it('replaces the typed trigger with one blurb node', () => {
    const { chain, calls } = makeChain();

    suggestion.command?.({
      editor: { chain: () => chain } as never,
      range: { from: 1, to: 5 },
      props: blurb,
    });

    expect(calls.deleteRange).toEqual([{ from: 1, to: 5 }]);
    expect(calls.insertContent).toHaveLength(1);
    expect(calls.insertContent[0]).toMatchObject({ type: 'blurb' });
  });

  it('🔴 removes the // trigger when Manage opens the manager', () => {
    const onManage = vi.fn();
    const { suggestion: live, manage } = createBlurbSuggestion({ getItems: () => [], onManage });
    const { chain, calls } = makeChain();
    // `clientRect: null` stops `onStart` short of floating-ui, after it has captured the props
    // `manage` reads; `isInitialized: false` defers ReactRenderer's render to a microtask that
    // never runs, because `manage` destroys the renderer first.
    const editor = { chain: () => chain, isInitialized: false, contentComponent: null };

    live.render?.().onStart?.({
      editor,
      range: { from: 4, to: 8 },
      query: 'sup',
      text: '//sup',
      items: [],
      command: () => undefined,
      clientRect: null,
      decorationNode: null,
    } as never);

    manage();

    expect(calls.deleteRange).toEqual([{ from: 4, to: 8 }]);
    expect(calls.insertContent).toEqual([]);
    expect(onManage).toHaveBeenCalledTimes(1);
  });
});
