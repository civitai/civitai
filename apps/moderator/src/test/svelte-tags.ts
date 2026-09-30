/**
 * One Svelte tag grammar, for the raw-source test pins.
 *
 * It was written four times across two files before this existed, and the copies had already
 * DIVERGED — `two-pane-stacking.test.ts` matched a name as `[a-zA-Z][a-zA-Z0-9-]*`, which cannot
 * match a dotted component tag (`<Select.Root>`, of which `ImageActionBar.svelte` and
 * `bulk-ban/+page.svelte` hold nine between them), while the newer copy had already widened it.
 * That is the worst shape for this corpus: a pin that stops matching does not fail, it silently
 * scans less, which is the same failure `strip-comments.ts` beside this file exists to prevent.
 *
 * For a nesting walk the narrow charset is worse than "scans less": `<Select.Root>` would be
 * invisible as an OPEN while `</Select.Root>` still matched as a CLOSE, so the stack would pop past
 * its own depth and every later ancestry answer would be wrong.
 *
 * 🔴 WHAT THIS IS NOT. It is a regex, not a parser. A `}` inside a string inside an attribute
 * expression (`{() => go("}")}`) ends the expression branch early and drops that tag. Over-dropping
 * is the SAFE direction — a pin that loses an element it was looking for fails loudly, which is why
 * every consumer is expected to carry a positive control asserting it found what it expected.
 */

export type SvelteTag = {
  /** The whole matched tag, as written. */
  raw: string;
  /** The name as written: `div`, `Checkbox`, `Select.Root`. */
  name: string;
  /** Everything between the name and the closing `>`, including the leading whitespace. */
  attrs: string;
  closing: boolean;
  selfClosing: boolean;
};

/**
 * Opening, closing and self-closing tags. The attribute run tolerates a `>` inside a quoted value
 * (`title="a > b"`) and inside a simple `{…}` expression (`onclick={() => x}`) — a naive `[^>]*`
 * drops the whole element.
 */
const TAG = /<(\/?)([a-zA-Z][\w.-]*)((?:[^>"'{]|"[^"]*"|'[^']*'|\{[^{}]*\})*?)(\/?)>/g;

/** HTML elements with no closing tag. A nesting walk that pushes these never pops them. */
export const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

export function tokenizeTags(source: string): SvelteTag[] {
  return [...source.matchAll(TAG)].map(([raw, closing, name, attrs, selfClosing]) => ({
    raw,
    name,
    attrs,
    closing: closing === '/',
    selfClosing: selfClosing === '/',
  }));
}

/** Every OPENING tag whose name is one of `names`. */
export function tagsNamed(source: string, ...names: string[]): SvelteTag[] {
  return tokenizeTags(source).filter((t) => !t.closing && names.includes(t.name));
}

/** Whether the tag carries `attribute`, valued or bare (`data-touch-target`). */
export function hasAttr(tag: SvelteTag, attribute: string): boolean {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|\\s)${escaped}(\\s|=|$)`).test(tag.attrs);
}

/**
 * The tag's LITERAL `class="…"`, or null where it has none — including `class={cn(…)}`, which is
 * unreadable here. Null means "cannot see it", never "has none": a caller must fail on it rather
 * than treat it as an empty class.
 */
export function classOf(tag: SvelteTag): string | null {
  return tag.attrs.match(/(^|\s)class="([^"]*)"/)?.[2] ?? null;
}

/**
 * Walks element nesting, calling `visit` for every opening tag with its ancestor chain (outermost
 * first). Svelte's `{#if}`/`{#each}` blocks open no element, so they do not affect the stack.
 */
export function walkTags(
  source: string,
  visit: (tag: SvelteTag, ancestors: readonly SvelteTag[]) => void
): void {
  const stack: SvelteTag[] = [];
  for (const tag of tokenizeTags(source)) {
    if (tag.closing) {
      stack.pop();
      continue;
    }
    visit(tag, stack);
    if (!tag.selfClosing && !VOID_ELEMENTS.has(tag.name.toLowerCase())) stack.push(tag);
  }
}
