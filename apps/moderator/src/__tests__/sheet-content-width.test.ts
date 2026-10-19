import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cn } from '@civitai/ui/utils.js';
import { describe, expect, it } from 'vitest';
import { stripComments } from '../test/strip-comments';
import { svelteFiles } from '../test/svelte-files';
import { classOf, tagsNamed } from '../test/svelte-tags';

/**
 * ⚠️ A CLASS-LEVEL PIN, NOT A COMPUTED-STYLE ONE. Nothing renders and no CSS is loaded: this
 * app's suite runs in Node. It merges every caller's class with the primitive's REAL base classes
 * through the REAL `cn` (tailwind-merge), which is the half of the defect that lives in code.
 *
 * The defect: every right-side sheet rendered 384px wide whatever its caller asked for. The
 * shadcn `SheetContent` sets its widths as `data-[side=right]:w-3/4` and
 * `data-[side=right]:sm:max-w-sm`. Tailwind compiles that variant to an attribute selector, which
 * out-specifies a caller's plain `w-[92vw]` / `sm:max-w-[72rem]` in the cascade, and
 * tailwind-merge keeps both because their variants differ. So a caller's width only takes effect
 * when it spells the SAME variant (`data-[side=right]:sm:max-w-[72rem]`), and twMerge then drops
 * the primitive's token. The primitive is CLI-generated and must not be hand-edited
 * (`packages/civitai-ui/README.md`), so the fix lives at the call sites and this pin holds them.
 *
 * 🔴 WHAT IT CANNOT SEE. The cascade premise above (data variant beats a plain class) is
 * Tailwind's, measured in a browser when this was written and not re-checked here. A caller whose
 * class is dynamic (`class={…}`) is unreadable and FAILS rather than passing over. Only this app's
 * callers are scanned.
 */
const dir = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(dir, '..');
const PRIMITIVE = path.resolve(
  SRC,
  '../../../packages/civitai-ui/src/lib/components/ui/sheet/sheet-content.svelte'
);

const baseMatch = /class=\{cn\(\s*"([^"]+)"/.exec(readFileSync(PRIMITIVE, 'utf8'));
if (!baseMatch) throw new Error(`could not read SheetContent's base classes from ${PRIMITIVE}`);
const BASE = baseMatch[1];
const BASE_TOKENS = new Set(BASE.split(/\s+/));

/** The utility of a class token with its variants removed, for the width family only. */
const widthUtility = (token: string): 'w' | 'max-w' | null => {
  const bare = token.slice(token.lastIndexOf(':') + 1);
  if (bare.startsWith('max-w-')) return 'max-w';
  if (bare.startsWith('w-')) return 'w';
  return null;
};

/**
 * The primitive's side-specific width tokens that survive the merge AND compete with a width the
 * caller set. Each one out-specifies the caller's token wherever both apply.
 */
function overriddenBy(callerClass: string, side: string): string[] {
  const asked = new Set(callerClass.split(/\s+/).map(widthUtility).filter(Boolean));
  return cn(BASE, callerClass)
    .split(/\s+/)
    .filter(
      (t) =>
        BASE_TOKENS.has(t) && t.startsWith(`data-[side=${side}]:`) && asked.has(widthUtility(t))
    );
}

const callers = svelteFiles(SRC).flatMap((file) =>
  tagsNamed(stripComments(readFileSync(file, 'utf8')), 'SheetContent', 'Sheet.Content').map(
    (tag) => ({
      file: path.relative(SRC, file),
      cls: classOf(tag),
      hasClass: /(^|\s)class=/.test(tag.attrs),
      dynamicSide: /(^|\s)side=\{/.test(tag.attrs),
      side: /(^|\s)side="(\w+)"/.exec(tag.attrs)?.[2] ?? 'right',
    })
  )
);

describe('SheetContent: a caller-supplied width reaches the page', () => {
  it('the predicate flags the shape that shipped (positive control)', () => {
    // The pre-fix TrainingDataSheet class, which rendered at 384px instead of 1152px.
    expect(overriddenBy('w-[92vw] overflow-y-auto sm:max-w-[72rem]', 'right')).toEqual([
      'data-[side=right]:w-3/4',
      'data-[side=right]:sm:max-w-sm',
    ]);
    expect(
      overriddenBy(
        'overflow-y-auto data-[side=right]:w-[92vw] data-[side=right]:sm:max-w-[72rem]',
        'right'
      )
    ).toEqual([]);
  });

  it('a caller that passes no width keeps the default (75%, 384px from sm)', () => {
    const merged = cn(BASE, 'overflow-y-auto').split(/\s+/);
    expect(merged).toContain('data-[side=right]:w-3/4');
    expect(merged).toContain('data-[side=right]:sm:max-w-sm');
  });

  it('finds every known caller', () => {
    const files = new Set(callers.map((c) => c.file));
    for (const known of [
      'lib/components/TrainingDataSheet.svelte',
      'lib/components/user-card/UserCard.svelte',
      'lib/components/text-scan-lab/PromptHistoryDrawer.svelte',
      'routes/text-scan/model-rules/RuleHistoryDrawer.svelte',
      'routes/audit/scanner-audit/[mode]/[label]/+page.svelte',
    ]) {
      expect(files).toContain(known);
    }
    expect(callers.length).toBeGreaterThanOrEqual(6);
  });

  it.each(callers.map((c) => [`${c.file} (side=${c.side})`, c] as const))(
    '%s: no primitive width token out-specifies the caller',
    (_, { cls, hasClass, dynamicSide, side }) => {
      if (dynamicSide) throw new Error('side is an expression; this pin cannot tell which side');
      // No class at all is the default width, which is legitimate (see the no-width case above).
      if (!hasClass) return;
      if (cls === null || cls.includes('{')) {
        throw new Error('class is not a plain literal; this pin cannot read every token');
      }
      expect(overriddenBy(cls, side)).toEqual([]);
    }
  );
});
