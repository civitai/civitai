import type { MouseEvent, ReactNode } from 'react';
import { Box, CopyButton, rem } from '@mantine/core';
import { IconCheck, IconClipboard } from '@tabler/icons-react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

/**
 * The copy-to-clipboard MECHANICS, with no opinion about what is being copied.
 *
 * 🔴 EXTRACTED SO THE COPY COUNT STOPS GROWING. `CopyableCommand` exists because
 * `GetStartedBody` and `CliSubmitCta` each carried a byte-identical private copy of a copy
 * button and `/apps/build` needed a third; its own header records that. The agent prompt
 * cannot reuse `CopyableCommand` itself, because that component renders `` `$ ${command}` ``
 * — a shell prompt sigil in front of a one-line command — and its `aria-label` is literally
 * `Copy command: …`. The prompt is multi-line prose, so it would render as "$ Read https://…"
 * and announce itself to a screen reader as a command.
 *
 * ⚠️ `word-break: break-all` IS NOT A THIRD REASON, THOUGH THIS NOTE AND `CopyableCommand`'s
 * HEADER BOTH LISTED IT AS ONE. `<Code block>` computes `white-space: pre` / `nowrap`, so no
 * soft wrap happens and `break-all` has nothing to act on — measured in
 * `src/components/CopyAffordance/CopyAffordance.geometry.test.tsx`, where `CopyableCommand`'s
 * own long-command fixture SCROLLS (`scrollWidth` 572 against `clientWidth` 390) instead of
 * wrapping. The property is still set on the bodies that carried it — inert there, not
 * load-bearing, and deliberately not deleted; no count of them is given here, for the reason
 * the next paragraph gives. The conclusion above is unaffected: it rests on the sigil and the
 * `aria-label`, both of which are rendered output.
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
 * `Collections/CollectionInviteLink.tsx` keeps its own shell and carries an `aria-label`.
 *
 * 🔴 THAT EXCEPTION NEEDS **TWO** PROPS HERE, NOT ONE, AND THIS SENTENCE USED TO CLAIM ONE.
 * The `disabled={!joinUrl}` state this component does not model is the half that was written
 * down. The other half is the INSET: `right={COPY_ICON_INSET}` is emitted as an INLINE STYLE
 * (deliberately — see the note on that prop), and an inline style beats `iconClassName`'s
 * Tailwind `right-2`, so `iconClassName` CANNOT move it. A caller at `right={10}` therefore
 * needs an `inset` prop as well. And `bodyClickCopies={false}` is not a substitute for the
 * first half: the icon's own `onClick` is unconditional, so the CONTROL would still copy `''`.
 * Weigh the reuse trade against two new props on seven live consumers, none of which exercises
 * a disabled state — and note that an unexercised `disabled` prop in here is precisely where
 * the "guard on one element, handler on another" defect would reappear, for all seven.
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
              // Duplicates the Tailwind `right-2` in the default class as an inline style, so
              // the offset survives a utility-class purge. See {@link COPY_ICON_INSET} for why
              // the number is shared rather than retyped.
              //
              // 🔴 THIS IS MANTINE'S `right=` STYLE PROP AND IT REM-IFIES ITS ARGUMENT — KEPT
              // DELIBERATELY, BECAUSE THE OTHER TWO TERMS DO TOO. `right` is `{type: 'size'}`
              // in `core/Box/style-props/style-props-data.cjs`, so `8` goes through
              // `sizeResolver` → `rem()` and renders `calc(0.5rem * var(--mantine-scale))`.
              // The control's own border box is `--ai-size-md`, which in the stylesheet this
              // app imports (`@mantine/core/styles.layer.css`) is
              // `calc(1.75rem * var(--mantine-scale))` — NOT the `28px` the per-component
              // `styles/ActionIcon.css` carries; that file is not in the cascade here. So both
              // terms track the root font size, and {@link COPY_BODY_PADDING_RIGHT} is in
              // `rem()` to match. Hard-coding a px inset here would RE-BREAK the clearance by
              // de-synchronising it from a control that still grows.
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
 * ⚠️ AND ONE BODY AT A DIFFERENT INSET, WHICH IS WHY THE RELATION IS A FUNCTION. The
 * invite-link block — now `~/components/Collections/CollectionInviteLink.tsx`, extracted from
 * `Collections/CollectionEditModal.tsx` — keeps its own shell rather than routing through this
 * component (it gates on `disabled={!joinUrl}`, which this component does not model) and sits
 * at `right={10}`, so `COPY_BODY_PADDING_RIGHT` is the wrong number for it by 2px. It reserves
 * {@link copyBodyPaddingRight}`(10)` instead, and is measured by the same geometry suite.
 *
 * ⚠️ IT RESERVED NOTHING AT ALL UNTIL THEN, AND THIS PARAGRAPH'S FIGURE WAS A DERIVATION THAT
 * TURNED OUT TO BE RIGHT. It read "a clearance of −1.75·R, i.e. −28px at a 16px root font
 * size … DERIVED from that file's props and the rules above, NOT measured — no fixture mounts
 * it". A fixture mounts it now, and the measurement agrees exactly: **−28px at R=16** (the body
 * reserved Mantine's default 10px against a 10px inset and a 28px control) and **−35px at
 * R=20**, i.e. −1.75·R at both points. Recorded because a derivation that was confirmed is
 * worth distinguishing from the three in this file's history that were overturned.
 *
 * ⚠️ BUT THE OVERLAP WAS **LATENT**, NOT LIVE, AND THE OLD PARAGRAPH IMPLIED OTHERWISE BY
 * SAYING "on a full URL whose tail therefore scroll-paints under the icon". No full URL ever
 * reached that body: its `env` read came from `process` rather than `~/env/client`, so the
 * value was `''` unconditionally in the browser. The geometry above is what the body does to a
 * URL that renders — which only became possible when that import was fixed, in the same commit
 * as the padding. A measured clearance is not by itself evidence that anyone saw the defect.
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
 * The control's rendered BORDER BOX AT A 16px ROOT FONT SIZE — `LegacyActionIcon`'s default
 * size, not the glyph's.
 *
 * 🔴 THE NUMBER THE CLEARANCE IS MADE OF, AND IT IS NOT A FUNCTION OF `COPY_ICON_SIZE`. 28 is
 * `--ai-size-md`. The ActionIcon root rule sets `width`/`height`/`min-width`/`min-height` to
 * `var(--ai-size)` and centres its child with `display: inline-flex` +
 * `align-items`/`justify-content: center` — so the box is INDEPENDENT OF THE GLYPH: bumping
 * `COPY_ICON_SIZE` to 20 for legibility moves this constant by nothing and needs no call-site
 * change at all. The glyph is what this file passes; the border box is what can overlap the
 * text.
 *
 * 🔴 BUT 28 IS ONLY ITS px VALUE AT R=16 — THE BOX IS REM-SCALED, AND THE TWO MANTINE
 * STYLESHEETS DISAGREE ABOUT THAT. READ THE ONE IN THE CASCADE. `@mantine/core@7.17.8/styles/ActionIcon.css` (and its `.layer` twin) declares a
 * literal `--ai-size-md: 28px`; the BUNDLE this app actually imports,
 * `@mantine/core/styles.layer.css` (see `src/pages/_app.tsx`), declares
 * `calc(1.75rem * var(--mantine-scale))`. The per-component file is not in the cascade here,
 * so quoting it is how a "fixed 28px" claim gets made about a box that measures **35px at a
 * 20px root font size** — measured, in the root-font-size block of
 * `src/components/CopyAffordance/CopyAffordance.geometry.test.tsx`. That is why
 * {@link COPY_BODY_PADDING_RIGHT} is a `rem()` string rather than this number plus one.
 *
 * ⚠️ THIS DOC SAID THE BOX "carries the 16px glyph with 6px either side" AND THAT MECHANISM
 * DOES NOT EXIST. No ActionIcon rule declares `padding` at all, so there is no padding to be
 * 6px of — and 16+6+6 could not be an inside-the-border accounting of a BORDER box anyway.
 * What the cascade gives at R=16 is a 1px transparent border (`--ai-bd`, which
 * `variant="transparent"` also resolves to `rem(1) solid transparent`), a 26px content box,
 * and the glyph flex-centred with 5px free per side — and that border is
 * `calc(0.0625rem * var(--mantine-scale))` too, so none of those three numbers is fixed either.
 *
 * Measured off the rendered control by the geometry suite rather than taken on trust, so a
 * Mantine default-size change reds an assertion that names this constant instead of
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
 * 🔴 AND IT IS A `rem()` CSS STRING, NOT A NUMBER — BECAUSE THE OTHER TWO TERMS SCALE WITH THE
 * ROOT FONT SIZE AND A RAW NUMBER DOES NOT. This was a live overlap, not a hypothetical. The
 * inset goes through Mantine's `right=` style prop (`sizeResolver` → `rem()` →
 * `calc(0.5rem * var(--mantine-scale))`) and the control's border box is `--ai-size-md`, which
 * in the bundle this app imports is `calc(1.75rem * var(--mantine-scale))`. Against a raw
 * `36` the clearance was therefore `36 − 2.25R`, i.e. `0` at a 16px root font size — which is
 * what every measurement in the geometry suite reported — and NEGATIVE at every larger one:
 * **−9px at R=20, −18px at R=24**, with the tail of an API key or client secret rendered under
 * the clipboard icon. Nothing pins R: `src/styles/globals.css` declares no `html { font-size }`
 * (its only `16px` is an iOS `input:focus` override) and nothing overrides `--mantine-scale`,
 * so a reader with a browser font-size preference got the defect. `rem()` is Mantine's OWN
 * converter — the same one the inset's style prop calls — so the three terms cannot drift
 * apart by construction, and `2.25rem` is exactly `0.5rem + 1.75rem`.
 *
 * ⚠️ THE NUMBERS IN THE SUM ARE px-AT-R=16 REFERENCE VALUES, which is also how Mantine spells
 * its own sizes (`rem()` divides by 16). Consumers apply this STRING to `paddingRight`; it is
 * no longer something to do arithmetic on, and the geometry suite compares the RENDERED
 * padding against the RENDERED control instead.
 *
 * ⚠️ IT ONCE SPELLED `COPY_ICON_INSET + COPY_ICON_SIZE + 12` AND CALLED THE `12` BREATHING
 * ROOM. Same total, wrong mechanism — and then wrong a second time: the correction that
 * replaced it ("the button's own padding, 6 per side") invented a padding declaration that no
 * ActionIcon rule contains. What is true is only that the sum happened to equal the control's
 * border box, which {@link COPY_CONTROL_SIZE} names directly; no decomposition belongs here.
 *
 * ⚠️ AND THERE IS NO SLACK, AT ANY VIEWPORT OR ROOT FONT SIZE. The measured clearance on a
 * correctly padded body is 0.00px, by construction rather than by luck. Worth knowing before
 * you read a failure: the geometry suite's `clearance >= 0` assertion sits exactly ON its own
 * boundary, so anything that widens the control by one pixel reds it. That is the right
 * direction to fail in, and it is not slack.
 */
export const COPY_BODY_PADDING_RIGHT = copyBodyPaddingRight(COPY_ICON_INSET);

/**
 * The clearance RULE, for a body whose control sits at an inset other than {@link
 * COPY_ICON_INSET}.
 *
 * 🔴 EXTRACTED SO THE RELATION IS SPELLED ONCE. `COPY_BODY_PADDING_RIGHT` above is this
 * function at this module's own inset; `Collections/CollectionInviteLink.tsx`'s invite-link
 * block is the second caller, at `right={10}`. Before this existed, the only way to clear a
 * control at a different inset was to retype `rem(inset + COPY_CONTROL_SIZE)` at the call
 * site — two copies of one rule, either of which could be the one not updated when the
 * control's box moves. The `rem()` and the `COPY_CONTROL_SIZE` term are the halves that have
 * each already been got wrong once (see the two ⚠️ paragraphs above); the inset is the only
 * part that is legitimately per-call-site, so it is the only parameter.
 *
 * ⚠️ NOT A WIDENING OF THE AFFORDANCE'S API. This exports the arithmetic, not a new prop:
 * `CopyAffordance` itself still renders at one inset and nothing about its component surface
 * changes. A caller passing its own inset is a caller that keeps its own shell, which is the
 * situation the ⚠️ counterexample paragraph above describes.
 *
 * @param inset the control's distance from the body's right edge, in px at a 16px root font
 *   size — the same unit the `right=` style prop takes.
 */
export function copyBodyPaddingRight(inset: number) {
  return rem(inset + COPY_CONTROL_SIZE);
}

/** The default glyph pair, exported so a `renderGlyph` can wrap it rather than restate it. */
export function CopyGlyph({ copied, size = COPY_ICON_SIZE }: { copied: boolean; size?: number }) {
  return copied ? <IconCheck size={size} /> : <IconClipboard size={size} />;
}
