import type { MouseEvent, ReactNode } from 'react';
import { Box, CopyButton } from '@mantine/core';
import { IconCheck, IconClipboard } from '@tabler/icons-react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

/**
 * The copy-to-clipboard MECHANICS, with no opinion about what is being copied.
 *
 * 🔴 EXTRACTED SO THE COPY COUNT STOPS GROWING. `CopyableCommand` exists because
 * `GetStartedBody` and `CliSubmitCta` each carried a byte-identical private copy of a copy
 * button and `/apps/build` needed a third; its own header records that. The agent prompt
 * cannot reuse `CopyableCommand` itself, because that component renders `` `$ ${command}` ``
 * — a shell prompt sigil in front of a one-line command, inside a `Code block` with
 * `word-break: break-all`. The prompt is multi-line prose, so it would render as
 * "$ Read https://…" with its words broken mid-token, and `CopyableCommand`'s `aria-label`
 * is literally `Copy command: …`.
 *
 * ⚠️ NO TOTAL IS STATED HERE, DELIBERATELY. Two successive comments in this family each
 * claimed a count ("not a fourth copy", then "a fifth") and each was wrong, and a third
 * attempt — an enumerated-equality ledger test over `src/components/Apps/` — was deleted
 * rather than widened: it enforced a repo-wide convention in one of five directories, its
 * own header conceded the wider form "would be red on arrival", and in its whole life it
 * never went red for anything but a planted mutant.
 *
 * 🔴 WHAT REPLACED IT IS THIS FILE'S LOCATION AND ITS REQUIRED `label`, NOT ANOTHER GUARD.
 * It used to live under `components/Apps/`, which is why the copies in `Account/` and
 * `Collections/` were somebody else's problem; it is now a plain shared component, and the
 * four `Code`-block copies that sat in `Account/ApiKeyModal.tsx` and
 * `Account/OAuthAppsCard.tsx` route through it. `label` is REQUIRED and has no default, so
 * the defect those four shared — a copy control for an API key or a client secret with no
 * accessible name at all, announced to a screen reader as "button" — is a type error here
 * rather than something a reviewer has to notice. One remaining local copy is deliberate:
 * `Collections/CollectionEditModal.tsx` gates its control on `disabled={!joinUrl}`, which
 * this component does not model, so it keeps its own shell and carries an `aria-label`.
 *
 * `onCopy` is OPTIONAL and defaults to nothing. That is what keeps `GetStartedBody`,
 * `CliSubmitCta` and {@link AgentOnboardingCard} the "pure presentational (props-only, no
 * tRPC / no network)" components their headers claim — a property their
 * `*.browser.test.tsx` suites depend on, since they mount them with no providers. The
 * analytics call lives at the ONE call site that has a tracker (`AppsBuildBody`), threaded
 * down as a callback rather than by importing a hook in here.
 *
 * ⚠️ WHY MANTINE'S `CopyButton` AND NOT `~/components/CopyButton/CopyButton`. The repo has
 * its own wrapper that yields `{copied, copy, Icon, color}` over `useClipboard` — strictly
 * more than this uses, and it also accepts `value` as a thunk.
 *
 * The honest reason is scope, not incompatibility. An earlier draft of this note claimed
 * adopting it "would change `CopyableCommand`'s rendered output"; that is NOT true — the
 * `Icon`/`color` it yields are suggestions a consumer can ignore, so this component could
 * adopt it and keep rendering `IconClipboard`/`green` unchanged. What is true is that
 * swapping the wrapper under an extraction whose whole promise is "the rendered output does
 * not change" means re-verifying three existing call sites for a seam that is already one
 * layer deep. Which of the two is canonical is worth deciding once, deliberately, for the
 * whole repo — not as a side effect of this change.
 */
export function CopyAffordance({
  value,
  label,
  onCopy,
  iconClassName = 'absolute right-2 top-1/2 -translate-y-1/2',
  renderGlyph,
  bodyClickCopies = true,
  children,
  'data-testid': testId,
}: {
  /** The exact bytes handed to the clipboard. */
  value: string;
  /** The copy control's accessible name. Consumer-supplied — "command" is not universal. */
  label: string;
  /**
   * Fired on an ATTEMPTED copy — not on a successful one.
   *
   * 🔴 NOT "on a successful copy", which is what `CopyableCommand`'s prop doc said once and
   * what the code cannot deliver. `handleCopy` calls Mantine's `copy()` and then `onCopy?.()`
   * unconditionally; `copy()` returns `void` and `CopyButton` surfaces no success signal, so
   * there is nothing to branch on. A denied clipboard permission or a non-secure context
   * still emits. Gating the step on a signal Mantine does not expose would mean
   * reimplementing the copy itself.
   */
  onCopy?: (value: string) => void;
  /** Where the icon sits. The default is the command block's right-middle. */
  iconClassName?: string;
  /**
   * Presentation of the clipboard/check glyph. Defaults to the plain icon swap.
   *
   * This is the ONLY seam the two consumers differ on beyond the body: the agent card pops
   * the glyph as it morphs. The wiring around it — which element is clicked, what it is
   * called, that it does not double-fire — stays here for both.
   */
  renderGlyph?: (copied: boolean) => ReactNode;
  /**
   * Whether clicking the BODY copies, as well as the control. Default `true`.
   *
   * 🔴 `false` FOR A PROSE BODY, AND THAT IS A DELETION THAT CLOSED FIVE REVIEW FINDINGS
   * RATHER THAN A PREFERENCE. A body-wide click target fights text selection, because the
   * `mouseup` ending a drag-select is followed by a `click` on the same element. Guarding it
   * was tried and abandoned: a selection test at `click` time could not tell a drag-select
   * from a stale selection (so a stale one silently disabled the panel), keyed on
   * `anchorNode` it missed a shift-click extension — which on `AuthorViaGit` put a live push
   * token on the clipboard from a gesture that was not a copy — and its scoping half was
   * itself unguarded, where losing it would have let any selection anywhere on the page
   * suppress every copy. Three timing-dependent failure modes to keep a convenience on a
   * body nobody needs to click.
   *
   * So prose bodies opt out and the control is the only copy path — it is a real `<button>`,
   * reachable by Tab, with its own accessible name. One-line COMMAND blocks keep the
   * body click: selecting a fragment of `npm install -g @civitai/cli` is not a thing people
   * do, the affordance predates this component at all three of those call sites, and leaving
   * the default `true` is what keeps `onCopy`'s "fires on an ATTEMPTED copy" contract exactly
   * as documented for them.
   */
  bodyClickCopies?: boolean;
  /** The copyable body. Receives `copied` so it can show its own copied state. */
  children: (state: { copied: boolean }) => ReactNode;
  'data-testid'?: string;
}) {
  return (
    <CopyButton value={value}>
      {({ copied, copy }) => {
        const handleCopy = () => {
          copy();
          onCopy?.(value);
        };
        return (
          <Box
            pos="relative"
            onClick={bodyClickCopies ? handleCopy : undefined}
            style={bodyClickCopies ? { cursor: 'pointer' } : undefined}
            data-testid={testId}
          >
            {children({ copied })}
            <LegacyActionIcon
              className={iconClassName}
              // Duplicates the Tailwind `right-2` in the default class (both 8px) as an
              // inline style, so the offset survives a utility-class purge. See
              // {@link COPY_ICON_INSET} for why the number is shared rather than retyped.
              right={COPY_ICON_INSET}
              variant="transparent"
              color="gray"
              aria-label={label}
              // 🔴 STOPS PROPAGATION — AND ONLY MATTERS WHEN `bodyClickCopies` IS TRUE, which
              // is the default and therefore the case to protect. The icon sits INSIDE the Box
              // that also handles the click, so a press on it ran `copy()` twice: harmless for
              // the clipboard (idempotent), not for `onCopy`, which would post two funnel
              // events for one press and only for the icon. Kept unconditionally because the
              // alternative is a second branch that is right only while the prop is false.
              onClick={(e: MouseEvent) => {
                e.stopPropagation();
                handleCopy();
              }}
            >
              {renderGlyph ? (
                renderGlyph(copied)
              ) : copied ? (
                <IconCheck size={COPY_ICON_SIZE} />
              ) : (
                <IconClipboard size={COPY_ICON_SIZE} />
              )}
            </LegacyActionIcon>
          </Box>
        );
      }}
    </CopyButton>
  );
}

/**
 * The control's inset from the body's right edge, and the clearance a body must leave for it.
 *
 * 🔴 ONE COUPLING — FOR EVERY `Code`-BLOCK BODY. The control sits `COPY_ICON_INSET` from the
 * right and its BORDER BOX is `COPY_CONTROL_SIZE` wide, so a body that reserves less than
 * their sum renders its text UNDER the icon. That happened once already in this family.
 * `CopyableCommand`, `AuthorViaGit` and the four `Code` bodies in `Account/ApiKeyModal.tsx`
 * and `Account/OAuthAppsCard.tsx` apply `COPY_BODY_PADDING_RIGHT` inline;
 * {@link AgentOnboardingCard}'s prose panel sets its own clearance in its stylesheet (its
 * control sits top-right, not right-middle), so it is a SECOND spelling of the same idea.
 *
 * ⚠️ THE CLEARANCE IS A CLAIM ABOUT A BODY WHOSE VALUE *FITS*, AND NOTHING MORE. Measured at
 * 390px: `<Code block>` computes `white-space: pre` / `text-wrap-mode: nowrap` /
 * `overflow-x: auto`, so a value wider than the content box does not wrap — it scrolls, and a
 * scrolling `pre` paints across its own right padding. `CopyableCommand`'s long-command
 * fixture overflows exactly that way (`scrollWidth` 572 against `clientWidth` 390) and its
 * `word-break: break-all` is INERT under `nowrap`. So the padding removes the overlap for
 * every value that fits and does not for one that does not. Clipping or wrapping instead
 * would be a rendered-output change at every call site; it is not what these constants buy,
 * and an assertion here cannot be read as "no value can ever sit under the icon".
 *
 * 🔴 BOTH SPELLINGS ARE MEASURED, NOT MERELY DOCUMENTED, BY
 * `src/components/CopyAffordance/CopyAffordance.geometry.test.tsx`. Until it existed, a
 * mutation that made this sum WRONG survived a 54-assertion sweep: nothing read the number
 * and nothing read a box, so the one defect the constants exist to prevent was invisible to
 * every suite. The geometry tier asserts the claim this doc makes — the control's box does
 * not overlap the body's text content box — rather than re-deriving the arithmetic, which
 * would pass against any value the implementation happened to produce.
 */
export const COPY_ICON_INSET = 8;
/**
 * The GLYPH's rendered size — what gets passed to the tabler icon, not the control's box.
 *
 * ⚠️ 16 IS A CHANGE AT THE FOUR `Account/` CALL SITES AND IT IS DELIBERATE. The shells this
 * component replaced there rendered a bare `<IconClipboard />`, i.e. tabler's default 24,
 * inside the same 28px button — 24-of-28, nearly edge to edge. The three call sites that
 * already routed through here have always rendered 16, so one of the two had to move for the
 * affordance to be one affordance, and 16 is also the commonest glyph size in this repo's
 * `LegacyActionIcon` call sites — a PLURALITY, not a rule: 50 of the 128 that pass a size,
 * against 21 at 14 and 19 at 18 (grepped, so a majority of what that grep sees). What is not
 * a judgement call is that the BUTTON box — the click and touch target — is
 * `COPY_CONTROL_SIZE` either way and did not move, and that the geometry suite now measures
 * both numbers.
 */
export const COPY_ICON_SIZE = 16;
/**
 * The control's rendered BORDER BOX — `LegacyActionIcon`'s default size, not the glyph's.
 *
 * 🔴 THE NUMBER THE CLEARANCE IS MADE OF, AND IT IS NOT `COPY_ICON_SIZE`. A Mantine
 * `ActionIcon` at its default `size="md"` is 28px square and carries the 16px glyph with 6px
 * either side. The glyph is what this file passes; the border box is what can overlap the
 * text. Measured off the rendered control by the geometry suite rather than taken on trust,
 * so a Mantine default-size change reds an assertion that names this constant instead of
 * reappearing as a mysterious one-pixel clearance failure.
 */
export const COPY_CONTROL_SIZE = 28;
/**
 * Right padding a `Code`-style body must carry so the control never overlaps its text.
 *
 * 🔴 DERIVED, NOT A SECOND LITERAL. The doc above states the relation; stating it was not
 * enforcing it, and a bump to the inset would silently shrink the clearance — re-arming the
 * exact defect the constants were introduced to prevent.
 *
 * ⚠️ IT SPELLED `COPY_ICON_INSET + COPY_ICON_SIZE + 12` AND CALLED THE `12` BREATHING ROOM.
 * Same total, wrong mechanism: 12 is the button's own padding, 6 per side, so that sum was
 * the border box re-derived by coincidence and there is NO breathing room — measured
 * clearance on a correctly padded body is 0.00px at both 390 and 360. Worth knowing before
 * you read a failure: the geometry suite's `clearance >= 0` assertion therefore sits exactly
 * ON its own boundary, so anything that widens the control by one pixel reds it. That is the
 * right direction to fail in, and it is not slack.
 */
export const COPY_BODY_PADDING_RIGHT = COPY_ICON_INSET + COPY_CONTROL_SIZE;

/** The default glyph pair, exported so a `renderGlyph` can wrap it rather than restate it. */
export function CopyGlyph({ copied, size = COPY_ICON_SIZE }: { copied: boolean; size?: number }) {
  return copied ? <IconCheck size={size} /> : <IconClipboard size={size} />;
}
