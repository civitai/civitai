import type { InputWrapperProps } from '@mantine/core';
import { Button, Input } from '@mantine/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Editor, JSONContent } from '@tiptap/react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { IconDice5, IconEye, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { openWildcardPreview } from '~/components/Dialog/triggers/wildcard-preview';
import { editPromptAttentionRange } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useGraph, useGraphSubscription } from '~/libs/data-graph/react/DataGraphProvider';
import type { SnippetReference, SnippetsNodeValue } from '~/shared/data-graph/generation/common';
import { parsePromptSnippetReferences } from '~/utils/prompt-helpers';
import { SnippetCategory } from './SnippetCategory';
import type { SnippetCategoryItem } from './SnippetCategoryList';
import { createSnippetCategorySuggestion } from './snippetCategorySuggestion';
import { useSnippetCategories } from './useSnippetCategories';

/**
 * Tiptap-based textarea-style input for the GenerationForm. Pairs with
 * `createTextEditorGraph` from the data-graph layer — the form passes the
 * editor node's meta straight through (`snippets`, `triggerWords`), no
 * intermediate hooks.
 *
 * Mostly a dumb component:
 *   - Plain `value` / `onChange` for the form value.
 *   - Optional `attentionEdit` for mod+ArrowUp/Down weight nudging.
 *   - Optional `onSubmit` for mod+Enter.
 *   - Optional `onPaste` observer.
 *
 * The one feature that breaks the headless contract is `snippets`:
 *   - When `snippets` is `undefined` (the editor's subgraph didn't merge
 *     `snippetsGraph`), the component is purely headless — no graph
 *     subscriptions, no trpc queries.
 *   - When `snippets` is defined (even `[]`), the component pulls graph
 *     context internally to fetch the loaded category list and resolves
 *     orphan chips. The `SnippetReference[]` array itself is forwarded for
 *     future per-target picker work and otherwise unused in v1.
 *
 * Form value is always a plain `string` round-tripped through Tiptap's
 * `getText()`. Snippet chips render `#${id}` so the serialized text matches
 * what `parsePromptSnippetReferences` and the server-side resolver expect.
 *
 * Sizing mirrors Mantine `Textarea`: `minRows` sets the empty-state height,
 * `maxRows` caps growth (scrolls past). Without `maxRows`, the editor grows
 * unboundedly with content (matching `autosize` Textarea).
 */

export type GenerationTextEditorProps = {
  // ──────────────── Form value ────────────────
  /** Plain-text value. */
  value?: string;
  /** Plain-text emitter — receives `editor.getText()` on every change. */
  onChange?: (value: string) => void;
  onBlur?: () => void;

  // ──────────────── Mantine Input.Wrapper passthrough ────────────────
  label?: InputWrapperProps['label'];
  description?: InputWrapperProps['description'];
  error?: InputWrapperProps['error'];
  withAsterisk?: InputWrapperProps['withAsterisk'];

  // ──────────────── Common input props ────────────────
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  autoFocus?: boolean;

  // ──────────────── Sizing (mirrors Mantine Textarea) ────────────────
  /** Minimum visible rows when empty. Default 1. */
  minRows?: number;
  /** Maximum visible rows; scrolls past this. Omit for unbounded growth. */
  maxRows?: number;

  // ──────────────── Optional features (opt-in via props) ────────────────
  /**
   * Observe paste events on the editor. Receives the native `ClipboardEvent`
   * matching the contract callers in GenerationForm rely on
   * (`event.clipboardData.getData('text/plain')`). Observation only — the
   * default Tiptap paste behavior always proceeds.
   */
  onPaste?: (event: ClipboardEvent) => void;
  /**
   * Fires when the user presses mod+Enter in the editor. Caller decides what
   * "submit" means in their environment — this component intentionally
   * doesn't reach into any form context. When omitted, mod+Enter falls
   * through to the editor's default behavior.
   */
  onSubmit?: () => void;
  /** Enable mod+ArrowUp / mod+ArrowDown attention-weight editing. Default false. */
  attentionEdit?: boolean;
  /**
   * Surfaced from `createTextEditorGraph`'s `meta.snippets`. `undefined` when
   * the subgraph didn't merge `snippetsGraph` (feature off); an array
   * (possibly empty) when it did (feature on). When defined, the component
   * loads the `SnippetCategory` extension, opens the `#`-trigger popover,
   * runs the orphan-chip scanner, and fetches the active wildcard-set
   * categories via `useSnippetCategories`. The `SnippetReference[]` payload
   * itself is reserved for the future per-target picker.
   */
  snippets?: SnippetReference[];
  /**
   * Trigger words for the active model/resources, surfaced from
   * `createTextEditorGraph`'s `meta.triggerWords`. Currently received but
   * not rendered — placeholder for future in-editor surfacing (chip strip,
   * inline insertion shortcut, etc.). Pass-through is harmless when empty.
   */
  triggerWords?: string[];
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'onBlur' | 'onPaste'>;

// Approximate per-row height for sizing math. Matches `text-sm` + `leading-snug`
// (1.375 line-height × 14px ≈ 19px, rounded with a hair of breathing room).
// Used only to translate `minRows`/`maxRows` into pixel min/max-height — the
// editor still auto-sizes naturally between those bounds.
const ROW_HEIGHT_PX = 22;
const SHELL_VERTICAL_PADDING_PX = 16; // py-2 → 8 + 8

/**
 * Outer entry point. Bifurcates on whether the editor's subgraph opted into
 * the snippets feature so the trpc / graph hooks inside `useSnippetCategories`
 * only fire for editors that actually use them.
 */
export function GenerationTextEditor(props: GenerationTextEditorProps) {
  if (props.snippets !== undefined) return <SnippetsAwareEditor {...props} />;
  return <EditorBody {...props} />;
}

function SnippetsAwareEditor(props: GenerationTextEditorProps) {
  const { categories, isLoading, loadedSets } = useSnippetCategories();
  const graph = useGraph();

  // Subscribe to the snippets node so the editor footer re-renders when the
  // modal writes a new seed back into `snippets.seed`. The hook returns
  // `null` when the active subgraph doesn't have a snippets node — that's
  // fine, the footer just won't render below.
  const snippetsSnapshot = useGraphSubscription(graph, 'snippets');
  const snippetsValue = snippetsSnapshot?.value as SnippetsNodeValue | undefined;
  const currentSeed = snippetsValue?.seed;

  // The Preview button lives on every snippets-aware editor but opens the
  // SAME modal that renders all current snippet targets — clicking from any
  // editor shows the full resolved set (prompt + negativePrompt + …). Read
  // the snapshot at click time so the modal reflects the user's edits up to
  // the moment they clicked.
  //
  // The footer only appears on an editor whose own value contains at least
  // one `#category` reference. Two reasons: (a) clicking would open an
  // empty modal otherwise, since the modal already filters out targets with
  // no refs, and (b) hiding the affordance when there's nothing to preview
  // keeps the editor visually quiet on a fresh form.
  const hasLoadedSets = loadedSets.length > 0;
  const hasRefsInThisEditor = useMemo(
    () => parsePromptSnippetReferences(props.value ?? '').length > 0,
    [props.value]
  );

  const onPreview = useCallback(() => {
    const snap = graph.getSnapshot() as Record<string, unknown> & {
      snippets?: SnippetsNodeValue;
    };
    const snippets = snap.snippets;
    if (!snippets) return;
    const targetKeys = Object.keys(snippets.targets ?? {});
    const targets = targetKeys
      .map((key) => {
        const text = typeof snap[key] === 'string' ? (snap[key] as string) : '';
        return { key, label: targetKeyToLabel(key), text };
      })
      // Skip targets that have no snippet references to resolve. The resolver
      // would just echo the template back unchanged, and the preview row
      // would be visually noisy without telling the user anything new (e.g.
      // an empty negativePrompt next to a prompt full of `#refs` adds zero
      // signal). Targets with at least one `#category` make the cut.
      .filter((t) => parsePromptSnippetReferences(t.text).length > 0);
    if (targets.length === 0) return;
    openWildcardPreview({
      wildcardSetIds: snippets.wildcardSetIds,
      targets,
      // Reopening the modal after a previous OK should show the same
      // resolution the user committed to — pass the current seed so the
      // first request reuses it instead of sampling fresh.
      initialSeed: snippets.seed,
      // Commit the modal's seed to form state when the user clicks OK.
      // FormFooter clears `snippets.seed` on submit so it never persists.
      onSeedChange: (seed) => {
        const current = (graph.getSnapshot() as { snippets?: SnippetsNodeValue }).snippets;
        if (!current) return;
        graph.set({ snippets: { ...current, seed } } as Parameters<typeof graph.set>[0]);
      },
    });
  }, [graph]);

  const onClearSeed = useCallback(() => {
    const current = (graph.getSnapshot() as { snippets?: SnippetsNodeValue }).snippets;
    if (!current || current.seed === undefined) return;
    const { seed: _seed, ...rest } = current;
    graph.set({ snippets: rest } as Parameters<typeof graph.set>[0]);
  }, [graph]);

  const showFooter = hasLoadedSets && hasRefsInThisEditor;

  return (
    <EditorBody
      {...props}
      _categories={categories}
      _loading={isLoading}
      _onPreview={showFooter ? onPreview : undefined}
      _currentSeed={showFooter ? currentSeed : undefined}
      _onClearSeed={showFooter ? onClearSeed : undefined}
    />
  );
}

/**
 * Convert a snippet target key (the editor node name) into a human-readable
 * label by splitting on camelCase boundaries and title-casing the result.
 *   prompt           → "Prompt"
 *   negativePrompt   → "Negative Prompt"
 *   musicDescription → "Music Description"
 *
 * Mirrors the labels the form's `<Controller>`s use for these editors —
 * those labels are hand-written today, but they all follow this rule, so
 * deriving here keeps the modal in sync without each editor having to
 * thread a label through to the preview path.
 */
function targetKeyToLabel(key: string): string {
  if (!key) return key;
  const spaced = key.replace(/([A-Z])/g, ' $1');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Inner body shared by both variants. The snippet category list and its
 * loading state arrive via private props (filled by `SnippetsAwareEditor`
 * when the feature is on, omitted otherwise). `snippets` itself still acts
 * as the on/off discriminator — when `undefined`, the SnippetCategory
 * extension never gets loaded.
 */
function EditorBody({
  value = '',
  onChange,
  onBlur,
  onPaste,
  onSubmit,
  label,
  description,
  error,
  withAsterisk,
  placeholder,
  disabled,
  className,
  autoFocus,
  minRows = 1,
  maxRows,
  attentionEdit = false,
  snippets,
  triggerWords: _triggerWords,
  _categories,
  _loading,
  _onPreview,
  _currentSeed,
  _onClearSeed,
  ...rest
}: GenerationTextEditorProps & {
  _categories?: SnippetCategoryItem[];
  _loading?: boolean;
  /**
   * Internal — supplied by `SnippetsAwareEditor` when the active subgraph has
   * snippets enabled AND the user has at least one wildcard set loaded AND
   * the editor's own value contains at least one `#category` reference.
   * When defined, the editor renders the snippets footer below the input
   * (separator + seed display + "Preview" button that opens the wildcard
   * preview modal). Always `undefined` for non-snippets editors so the
   * footer doesn't appear there.
   */
  _onPreview?: () => void;
  /**
   * Internal — current `snippets.seed` from form state. Echoed in the
   * footer so the user sees the same seed the modal will use on its next
   * open (and the seed used for the most recent preview/regenerate). When
   * undefined, the footer renders "Random" as a placeholder — the modal
   * will sample a fresh seed server-side on next open.
   */
  _currentSeed?: number;
  /**
   * Internal — clear the committed seed and return to "Random". Surfaced
   * as a small × inside the seed pill when a seed is currently set.
   */
  _onClearSeed?: () => void;
}) {
  // Refs for parent-supplied callbacks / data: the suggestion plugin and
  // editor handlers are baked into the `useEditor` config that we
  // intentionally rebuild only on a tiny set of deps. Inline-arrow callers
  // would otherwise capture stale references.
  const onPasteRef = useRef(onPaste);
  useEffect(() => {
    onPasteRef.current = onPaste;
  }, [onPaste]);
  const onSubmitRef = useRef(onSubmit);
  useEffect(() => {
    onSubmitRef.current = onSubmit;
  }, [onSubmit]);

  const snippetCategoriesRef = useRef<SnippetCategoryItem[]>(_categories ?? []);
  useEffect(() => {
    snippetCategoriesRef.current = _categories ?? [];
  }, [_categories]);

  // Loading state lives in a ref for the same reason categories do: the
  // suggestion plugin is baked into the editor at build time and reads its
  // inputs through these refs. The `suggestionRefreshRef` below pushes
  // mid-popover updates so a fetch that resolves (or a set add/remove
  // mutation that shifts the category list) while the popover is open
  // refreshes without requiring a keystroke.
  const snippetLoadingRef = useRef<boolean>(!!_loading);
  const suggestionRefreshRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    snippetLoadingRef.current = !!_loading;
    suggestionRefreshRef.current?.();
  }, [_loading, _categories]);

  // Configuration toggles also live in refs so the keydown handler can read
  // the current value without rebuilding the editor on every flag flip.
  const attentionEditRef = useRef(attentionEdit);
  useEffect(() => {
    attentionEditRef.current = attentionEdit;
  }, [attentionEdit]);

  // The editor instance itself also lives in a ref so the `handleKeyDown`
  // closure (baked in at editor build time) can reach the current editor.
  // With `immediatelyRender: false`, `useEditor` returns `null` on the first
  // render — the closure would otherwise capture that null and never recover,
  // silently no-op-ing mod+ArrowUp / mod+ArrowDown attention edits.
  const editorRef = useRef<Editor | null>(null);

  // The SnippetCategory extension must be present at editor-build time to
  // be available — toggling the `snippets` prop on/off rebuilds the editor.
  // Inside a single editor lifetime, the categories list itself can change
  // freely (see snippetCategoriesRef) without remounting.
  const snippetsEnabled = snippets !== undefined;

  const extensions = useMemo(() => {
    const list = [
      StarterKit.configure({
        // Prompts are flat text — disable every block-level structure so
        // Enter doesn't introduce paragraphs / lists / etc. that don't
        // round-trip cleanly through `editor.getText()`.
        heading: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
      }),
    ];
    if (snippetsEnabled) {
      const { suggestion, refresh } = createSnippetCategorySuggestion(
        (query) => {
          const q = query.toLowerCase();
          return snippetCategoriesRef.current.filter((c) =>
            (c.label ?? c.id).toLowerCase().startsWith(q)
          );
        },
        () => snippetLoadingRef.current
      );
      suggestionRefreshRef.current = refresh;
      list.push(SnippetCategory.configure({ suggestion }) as never);
    }
    return list;
  }, [snippetsEnabled]);

  const editor = useEditor(
    {
      extensions,
      // Tiptap needs DOM access; SSR pass would otherwise hydration-mismatch.
      immediatelyRender: false,
      content: parseTextToDoc(value, snippetsEnabled),
      editable: !disabled,
      onUpdate: ({ editor, transaction }) => {
        // Orphan-scan transactions only adjust the `orphan` attribute on
        // existing chips — the serialized text is byte-identical, so skip
        // the emit to avoid round-tripping a no-op value through the form.
        if (transaction.getMeta('orphanScan')) return;
        onChange?.(serializeEditorToText(editor));
      },
      onBlur: () => {
        onBlur?.();
      },
      editorProps: {
        attributes: {
          class: clsx(
            'tiptap-textarea-editor outline-none',
            // Mantine input-style baseline so the editor sits naturally
            // inside Input.Wrapper labels.
            'text-sm leading-snug',
            // Preserve consecutive spaces and explicit newlines instead of
            // letting the browser collapse them. ProseMirror's default CSS
            // (which sets this on `.ProseMirror`) isn't imported globally.
            'whitespace-pre-wrap'
          ),
          'data-placeholder': placeholder ?? (typeof label === 'string' ? label : ''),
        },
        handleKeyDown(_view, event) {
          const isMod = event.metaKey || event.ctrlKey;
          if (!isMod) return false;

          // mod+Enter — fire the caller's submit handler when present.
          // Without one, fall through (returning false) so Tiptap handles
          // the keystroke normally.
          if (event.key === 'Enter' && onSubmitRef.current) {
            event.preventDefault();
            onSubmitRef.current();
            return true;
          }

          // mod+ArrowUp / mod+ArrowDown — attention edit (opt-in, default
          // false). Run the shared text-only algorithm against a plain-text
          // view of the doc, then map char offsets back to ProseMirror
          // positions so the cursor lands inside the bumped weight ready
          // for repeated nudges.
          if (attentionEditRef.current && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            const ed = editorRef.current;
            if (!ed) return false;
            const handled = applyAttentionEdit(ed, event.key === 'ArrowUp', snippetsEnabled);
            if (handled) {
              event.preventDefault();
              return true;
            }
          }

          return false;
        },
        handlePaste(_view, event) {
          // Observation hook — runs before Tiptap's default paste handling.
          // Always returns false so the default behavior continues; this
          // preserves the standard text paste-in semantics. Snippet chip
          // detection from pasted text happens via the doc round-trip
          // (paste → text → onChange → external value sync → setContent
          // with `parseTextToDoc` re-running the snippet parser).
          if (event instanceof ClipboardEvent) {
            onPasteRef.current?.(event);
          }
          return false;
        },
        handleClickOn(view, _pos, node, nodePos, event) {
          // Orphan chip dismiss: clicks on the in-chip "×" affordance delete
          // the parent chip. `handleClickOn` fires with `node` set to the atom
          // the user clicked on; the target element check distinguishes a
          // click on the X from a click on the chip body (e.g. selecting text
          // around it), so non-remove clicks pass through to Tiptap's default
          // selection behavior. Delete uses `nodePos` (the atom's start) — not
          // the click `pos`, which can land inside the atom and produce a
          // wrong-range delete that leaves the chip in place.
          if (node.type.name !== 'snippetCategory' || !node.attrs.orphan) return false;
          const target = event.target;
          if (!(target instanceof Element)) return false;
          if (!target.closest('[data-snippet-chip-remove]')) return false;
          event.preventDefault();
          view.dispatch(view.state.tr.delete(nodePos, nodePos + node.nodeSize));
          return true;
        },
      },
    },
    // Rebuild only when the extension set or editable flag changes — content
    // sync is handled imperatively below so external value changes don't
    // tear down the editor and steal focus.
    [extensions, disabled]
  );

  // Sync external value changes (preset load, remix, parent-driven reset)
  // into the editor without rebuilding it. Compare against the editor's
  // own getText() to avoid stomping in-flight typing — onUpdate already
  // pushed a value up, and that re-entrant prop change would otherwise
  // cause a cursor-jump.
  useEffect(() => {
    if (!editor) return;
    const current = serializeEditorToText(editor);
    if (current === value) return;
    editor.commands.setContent(parseTextToDoc(value, snippetsEnabled), { emitUpdate: false });
  }, [editor, value, snippetsEnabled]);

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (autoFocus && editor) editor.commands.focus('end');
  }, [autoFocus, editor]);

  // Reactively flag `#category` chips that don't resolve against any loaded
  // wildcard set. Skipped while the snippet-category fetch hasn't resolved
  // yet so we never flash valid chips red during the initial fetch — orphans
  // only emerge once we have an authoritative "this is the full set of
  // loaded categories" list.
  //
  // The update path is attribute-only (`tr.setNodeAttribute`) — ProseMirror
  // preserves text content and selection across these transactions, so the
  // user's cursor stays put and `getText()` returns the same string (no
  // spurious onChange propagation up to the form).
  //
  // Re-runs whenever the loaded category set changes (and on doc updates,
  // so chips inserted after the initial scan get flagged too).
  useEffect(() => {
    if (!editor) return;
    if (!snippetsEnabled) return;
    if (_loading) return;

    const known = new Set<string>((_categories ?? []).map((c) => (c.label ?? c.id).toLowerCase()));

    const evaluate = () => {
      const updates: Array<{ pos: number; orphan: boolean }> = [];
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name !== 'snippetCategory') return true;
        const rawId = typeof node.attrs.id === 'string' ? node.attrs.id : '';
        const orphan = rawId.length > 0 && !known.has(rawId.toLowerCase());
        if (!!node.attrs.orphan !== orphan) {
          updates.push({ pos, orphan });
        }
        // Chips are atoms — no descendants worth walking into.
        return false;
      });
      if (updates.length === 0) return;
      const tr = editor.state.tr;
      for (const { pos, orphan } of updates) {
        tr.setNodeAttribute(pos, 'orphan', orphan);
      }
      // Tag the transaction so the editor's `onUpdate` can skip the
      // serialize-to-text + onChange path for these no-op text changes.
      tr.setMeta('orphanScan', true);
      editor.view.dispatch(tr);
    };

    evaluate();
    editor.on('update', evaluate);
    return () => {
      editor.off('update', evaluate);
    };
  }, [editor, snippetsEnabled, _loading, _categories]);

  // Sizing math: minRows establishes the empty-state height; maxRows caps
  // growth and switches the shell to scroll past that bound. Without
  // maxRows the editor grows freely with content.
  const shellStyle: CSSProperties = {
    minHeight: minRows * ROW_HEIGHT_PX + SHELL_VERTICAL_PADDING_PX,
    ...(typeof maxRows === 'number'
      ? { maxHeight: maxRows * ROW_HEIGHT_PX + SHELL_VERTICAL_PADDING_PX, overflowY: 'auto' }
      : null),
    ...rest.style,
  };

  return (
    <Input.Wrapper
      label={label}
      description={description}
      error={error}
      withAsterisk={withAsterisk}
    >
      <div
        {...rest}
        className={clsx(
          'tiptap-textarea-shell cursor-text rounded-md border border-solid px-3 py-2',
          'border-gray-3 bg-gray-0 dark:border-dark-4 dark:bg-dark-6',
          'focus-within:border-blue-5 dark:focus-within:border-blue-4',
          error && 'border-red-5 dark:border-red-5',
          disabled && 'opacity-60',
          className
        )}
        style={shellStyle}
        onMouseDown={(e) => {
          // Clicks anywhere in the padding / dead horizontal space inside
          // the shell focus the editor (matching <textarea> feel). When
          // the click lands inside the ProseMirror element itself, bail
          // out so the editor's own selection logic handles caret
          // placement at the click position.
          if (!editor || disabled) return;
          const editorEl = editor.view.dom;
          if (editorEl.contains(e.target as Node)) return;
          e.preventDefault();
          editor.commands.focus('end');
        }}
      >
        <EditorContent editor={editor} />
      </div>
      {/* Snippets-aware footer: separator + seed pill + preview button.
          Rendered only when `SnippetsAwareEditor` supplies the callback —
          i.e. snippets enabled, at least one wildcard set loaded, and this
          editor's value contains at least one `#category` reference. */}
      {_onPreview ? (
        <div className="mt-2 border-t border-gray-3 px-2 py-1 dark:border-dark-4">
          <div className="flex items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-1.5 text-gray-6 dark:text-dark-1">
              <span>Seed</span>
              <span className="font-mono font-semibold text-gray-8 dark:text-gray-3">
                {_currentSeed ?? 'Random'}
              </span>
              {/* Clear-X — only when a committed seed exists. Reverts the
                  footer to "Random" and frees the next preview to sample a
                  fresh seed on open. */}
              {_currentSeed !== undefined && _onClearSeed ? (
                <button
                  type="button"
                  onClick={_onClearSeed}
                  aria-label="Clear seed"
                  title="Clear seed"
                  className="flex size-4 items-center justify-center rounded text-gray-5 hover:bg-gray-2 hover:text-gray-8 dark:hover:bg-dark-5 dark:hover:text-gray-1"
                >
                  <IconX size={11} />
                </button>
              ) : null}
            </div>
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              leftSection={<IconEye size={12} />}
              onClick={_onPreview}
              disabled={disabled}
            >
              Preview
            </Button>
          </div>
        </div>
      ) : null}
    </Input.Wrapper>
  );
}

/**
 * Convert a plain-text value into a Tiptap doc. Each line of input becomes
 * its own paragraph so the round-trip through `editor.getText({
 * blockSeparator: '\n' })` preserves newlines verbatim — stuffing `\n`
 * characters into a single text node would let the DOM collapse them.
 * When snippet support is enabled, `#category` references within each
 * line become `snippetCategory` inline nodes.
 */
function parseTextToDoc(text: string, snippetsEnabled: boolean): JSONContent {
  const buildParagraph = (line: string): JSONContent => {
    if (!line) return { type: 'paragraph' };
    if (!snippetsEnabled) {
      return { type: 'paragraph', content: [{ type: 'text', text: line }] };
    }
    const refs = parsePromptSnippetReferences(line);
    if (refs.length === 0) {
      return { type: 'paragraph', content: [{ type: 'text', text: line }] };
    }
    const inline: JSONContent[] = [];
    let cursor = 0;
    for (const ref of refs) {
      if (ref.start > cursor) {
        inline.push({ type: 'text', text: line.slice(cursor, ref.start) });
      }
      inline.push({
        type: 'snippetCategory',
        attrs: { id: ref.category, label: ref.category },
      });
      cursor = ref.end;
    }
    if (cursor < line.length) {
      inline.push({ type: 'text', text: line.slice(cursor) });
    }
    return { type: 'paragraph', content: inline };
  };

  if (!text) {
    return { type: 'doc', content: [{ type: 'paragraph' }] };
  }
  const lines = text.split('\n');
  return { type: 'doc', content: lines.map(buildParagraph) };
}

/**
 * Read the editor's current value as a plain-text string. Tiptap's
 * `getText()` walks every node and (via the chip's `renderText`) emits
 * `#${id}` for snippet chips — so the form's serialized value matches
 * what `parsePromptSnippetReferences` and the server-side resolver expect.
 * `blockSeparator: '\n'` mirrors textarea semantics: each paragraph break
 * becomes a single newline, round-tripping cleanly with `parseTextToDoc`.
 */
function serializeEditorToText(editor: Editor): string {
  return editor.getText({ blockSeparator: '\n' });
}

/**
 * Tiptap-aware port of `keyupEditAttention`. The shared text-only algorithm
 * lives in `editPromptAttentionRange`; this wrapper handles the editor's
 * own coordinate system: collapse the doc to a plain-text view, run the
 * algorithm, then write the result back via `setContent` and map the
 * post-edit selection back to ProseMirror positions so the caret lands
 * inside the bumped weight ready for repeated nudges.
 *
 * Returns `true` when the keystroke produced an edit, `false` otherwise.
 */
function applyAttentionEdit(editor: Editor, isPlus: boolean, snippetsEnabled: boolean): boolean {
  const leafText = (node: PMNode): string => {
    if (node.type.name === 'snippetCategory') {
      const id = (node.attrs.id ?? '') as string;
      return `#${id}`;
    }
    return '';
  };

  const docEnd = editor.state.doc.content.size;
  const text = editor.state.doc.textBetween(0, docEnd, '\n', leafText);
  const startChar = editor.state.doc.textBetween(
    0,
    editor.state.selection.from,
    '\n',
    leafText
  ).length;
  const endChar = editor.state.doc.textBetween(0, editor.state.selection.to, '\n', leafText).length;

  const result = editPromptAttentionRange(text, startChar, endChar, isPlus);
  if (!result) return false;

  // setContent rebuilds the doc synchronously; subsequent reads of editor.state
  // already reflect the new structure, so the offset-mapper below operates on
  // the post-edit doc.
  editor.commands.setContent(parseTextToDoc(result.text, snippetsEnabled));
  editor.commands.setTextSelection({
    from: charOffsetToPmPos(editor, result.selectionStart),
    to: charOffsetToPmPos(editor, result.selectionEnd),
  });
  editor.commands.focus();
  return true;
}

/**
 * Walk the doc inline-by-inline, accumulating the text-rendering length of
 * each node (text nodes use their literal text length; snippetCategory atoms
 * use `#${id}`'s length to match `editor.getText()`). Paragraph boundaries
 * contribute one `\n` each to the flat text view (mirroring `textBetween`'s
 * blockSeparator), so we deduct one char on entering every paragraph after
 * the first. When the accumulated length reaches `charOffset`, emit the
 * corresponding ProseMirror position.
 *
 * Atomic chips can't host a cursor; offsets that fall inside a chip's
 * rendered text round to the nearest chip boundary (start when `remaining
 * == 0`, otherwise the position after the chip).
 */
function charOffsetToPmPos(editor: Editor, charOffset: number): number {
  let remaining = charOffset;
  let result = -1;
  let firstParagraph = true;
  editor.state.doc.descendants((node, pmPos) => {
    if (result !== -1) return false;
    if (node.type.name === 'paragraph') {
      if (!firstParagraph) {
        if (remaining === 0) {
          // Cursor lands at the start of this paragraph (inside the opening tag).
          result = pmPos + 1;
          return false;
        }
        remaining -= 1;
      }
      firstParagraph = false;
      return true;
    }
    if (node.isText) {
      const len = (node.text ?? '').length;
      if (remaining <= len) {
        result = pmPos + remaining;
        return false;
      }
      remaining -= len;
      return true;
    }
    if (node.type.name === 'snippetCategory') {
      const id = (node.attrs.id ?? '') as string;
      const len = `#${id}`.length;
      if (remaining < len) {
        result = remaining === 0 ? pmPos : pmPos + 1;
        return false;
      }
      remaining -= len;
      return true;
    }
    return true;
  });
  if (result === -1) result = editor.state.doc.content.size;
  return result;
}
