import { Box, Button, Group, Text, Tooltip } from '@mantine/core';
import { IconShieldCheck, IconX } from '@tabler/icons-react';

type BlockConsentNoticeProps = {
  /** The app's display name, as the host surface knows it. */
  appName?: string;
  /** Open the consent modal. The caller RE-RESOLVES the scope set at click time. */
  onReview: () => void;
  /** Retire the notice for this app, for this mount. */
  onDismiss: () => void;
};

/**
 * 🔴 THE MISSING-PERMISSIONS BACKSTOP, RENDERED OUTSIDE THE IFRAME.
 *
 * The mint is FAIL-CLOSED on a missing `app_user_scope_grants` row, so a viewer who
 * has never consented gets a token with every consent-gated scope withheld — and
 * until this existed the ONLY thing that could tell them was the block itself, via
 * REQUEST_CONSENT. An app that did not think to ask left the viewer with a
 * working-looking control that could never succeed.
 *
 * Measured 2026-09-08 on `playable-collections`: a real 2-Buzz tip was refused on
 * both legs at the scope gate, the Buzz ledger confirms nothing moved, and the
 * viewer saw only "None of that tip came back confirmed" — no prompt, no
 * explanation, permanently. `social:tip:self` was granted on ONE row in the whole
 * grants table, so that was the ORDINARY path.
 *
 * 🔴 OUTSIDE THE IFRAME, NOT INSIDE IT, ON BOTH SURFACES. The whole point is that
 * the host is recoverable regardless of what the block does — including a block
 * that never calls `requestGrants`, and a block running an SDK version with no such
 * call. Anything rendered by the block cannot satisfy that, and anything a block can
 * restyle or hide is not a backstop. Both hosts render it between the `AppBlockChrome`
 * provenance bar and the app's own box, which is host-owned chrome in both cases.
 *
 * 🔴 A NOTICE, NOT AN AUTO-OPENED MODAL, DELIBERATELY. A block can be fully usable
 * unconsented — `collections:read:self` is consent-exempt, so `playable-collections`
 * browses public collections fine with no grant at all — and an unconditional modal
 * would interrupt every viewer of every app that merely DECLARES a consent-gated
 * scope. The viewer decides.
 *
 * 🔴 PRESENTATION ONLY. Every condition deciding whether this appears lives in
 * `resolveHostConsentNotice` (`requestConsentGate.ts`), shared by both hosts. Do not
 * add a gate here: a second place for the same rule is exactly how the model slot
 * came to have no backstop for the whole life of the page host's.
 *
 * `role="status"` rather than `role="alert"`: it is an offer the viewer can ignore,
 * so it must not seize a screen reader mid-sentence.
 *
 * ── THE NARROW FORM ─────────────────────────────────────────────────────────────
 *
 * 🔴 A CONTAINER QUERY, NOT A VIEWPORT ONE, AND IT IS THE MODEL SIDEBAR — NOT THE
 * PHONE — THAT DECIDES THAT. This notice renders on both host surfaces: the full-page
 * `/apps/run/<slug>` frame and the `model.sidebar_top` slot, which is a ~320px column
 * on a desktop. A viewport query reports "desktop" for that bar and hands it the full
 * sentence plus two text buttons, i.e. exactly the overflow this form exists to
 * remove. `chromeGeometry.ts` next door reached the same conclusion for the chrome bar
 * ("the 360px phone AND the desktop model sidebar both land there — they are the same
 * layout problem"); this is its pure-CSS form, with no `ResizeObserver` and so none of
 * the one-frame post-mount shape swap that one pays.
 *
 * 🔴 AND CSS RATHER THAN A HOOK — BUT NOT FOR THE HYDRATION REASON, WHICH DOES NOT APPLY
 * HERE. ⚠️ An earlier revision of this paragraph said a JS swap "renders one shape in the
 * SSR HTML and another on the first client paint" and cited the incident
 * `AppsPageLayout.module.scss` records. That mechanism is UNREACHABLE for this component,
 * on two independent counts: `BlockSlot` loads the whole slot chain through
 * `dynamic(..., { ssr: false })`, and the gate in `requestConsentGate.ts` returns null
 * until `status === 'ready'`, which is only reached from the iframe's `BLOCK_READY`
 * post-message. This notice is never in the server HTML on either surface, so there is no
 * SSR tree for a hook to diverge from. That incident belongs to `AppsPageLayout` and
 * `useAppsNavSections`, which genuinely do server-render.
 *
 * The reason that DOES apply is the one two paragraphs up — but it is TWO reasons, not
 * one, and an earlier revision flattened them. Anything that MEASURES cannot answer
 * before it has measured, so it renders the wrong shape for a frame and then
 * restructures a bar the viewer is already reading. The three container-query hooks make
 * that concrete by returning a definite wrong answer: `useContainerQuery` yields `false`
 * at `inlineSize === 0`, `useContainerSmallerThan` wraps it, and bare `useIsMobile()`
 * routes to it. ⚠️ A raw `useResizeObserver` has the same timing problem by a different
 * route — it returns a REF and reports through a callback, with no boolean and no
 * zero-branch of its own (the guard lives in each caller, e.g. `chromeGeometry.ts`), so
 * do not describe it as returning `false`. A VIEWPORT query has a different problem — it answers
 * at first paint but answers the WRONG QUESTION, reporting "desktop" for the ~320px
 * model sidebar. ⚠️ Do not write "they all flash": this repo's own `useMediaQuery`
 * wrapper passes `getInitialValueInEffect: false`, so it reads `matchMedia`
 * synchronously on the first render and, with no SSR pass here, does not flash at all.
 * It is banned for the second reason. (Mantine's own `useMediaQuery`, imported directly,
 * defaults the other way and does flash.) CSS answers both.
 *
 * ⚠️ ENFORCED rather than merely documented: `local-rules/no-ssr-divergent-media-query`
 * is switched on for this file in `.eslintrc.js`. It names FOUR hooks — `useMediaQuery`,
 * `useIsMobile`, `useContainerQuery` and `useContainerSmallerThan`. The fourth is the one
 * worth spelling out, because that rule's own header says it is the easiest to omit and
 * is the one the `CollectionsLayout` precedent everybody copies actually uses.
 *
 * ⚠️ THAT IS A DIFFERENT FOUR FROM THE MECHANISMS LISTED ABOVE, AND THE OVERLAP IS NOT
 * TOTAL: the rule bans `useMediaQuery` (which the paragraph above says does NOT flash in
 * this repo's wrapper — it is banned for answering the wrong question) and does NOT ban
 * `useResizeObserver` (which does have the timing problem). So the lint rule is not a
 * complete guard against the flash; it is a guard against the four spellings people
 * actually reach for.
 *
 * 🔴 THE SWAP IS THE REPO'S OWN TAILWIND CONTAINER-QUERY PLUGIN, NOT A HAND-WRITTEN
 * MODULE. `src/tailwind/container-queries.js` (wired at `tailwind.config.js`) provides
 * `@container`, `@<key>:` and `@max-<key>:`, and `theme.extend.containers` is
 * `src/utils/breakpoints.json` — so `@xs`/`@max-xs` is 480px, the same rung and the
 * same single source every other container-query site here uses (`Logo.tsx` runs the
 * identical complementary pair for its two logo SVGs; `AnnouncementCard.tsx` uses the
 * same rung). An earlier revision of this file shipped an equivalent `.module.scss`,
 * which rebuilt all of that and — because it keyed off `theme('screens')` rather than
 * `theme('containers')` — put this one file on a different theme key from every other
 * site. The utility form also sits in the UNLAYERED Tailwind cascade, which outranks
 * `@layer modules`; the module form could have been silently overridden by any later
 * display utility on these nodes.
 *
 * ⚠️ `@container` MEANS THIS BOX CONTRIBUTES NO INTRINSIC INLINE SIZE. Inline-size
 * containment is what makes the query answerable, and the cost is that the notice
 * cannot size itself from its contents. Both current parents are block-level (the page
 * host's column flex child, the iframe host's plain `Box`), so it stretches as before.
 * Drop it into an `inline-block`, a float, a `width: max-content` box or a `grid` auto
 * column and it collapses to its padding.
 *
 * 🔴 ONE ELEMENT PER CONTROL, WITH ITS CONTENT SWAPPED — NOT TWO ELEMENTS, ONE OF THEM
 * HIDDEN. Rendering a `Button` and an `ActionIcon` and letting the query pick would
 * DUPLICATE `data-testid="block-consent-notice-review"` and `…-dismiss` in the DOM, and
 * the two existing suites that drive this notice (`PageBlockHost.browser.test.tsx`,
 * `IframeHostConsentNotice.browser.test.tsx`) resolve those ids strictly — two matches
 * is an error, not a pick. So each control is a SINGLE button carrying the id, and what
 * swaps is the LABEL inside it. The testids, the click handlers and the accessible names
 * are therefore width-INDEPENDENT, which is the property worth having regardless of the
 * ids.
 *
 * 🔴 WHAT A SCREEN READER HEARS DOES NOT CHANGE WITH WIDTH, AND THAT IS WHY THE LONG
 * SENTENCE IS `sr-only` BELOW THE RUNG RATHER THAN `hidden`. `display: none` removes
 * content from the accessibility tree, so hiding the sentence outright would have left
 * an AT user with "Missing permissions" and no app name — an announcement whose content
 * depended on a rendered width they cannot perceive. Clipping it instead keeps the full
 * sentence in the live region at every width, and the short form carries `aria-hidden`
 * so the two are never announced together.
 *
 * 🔴 EACH BUTTON CARRIES AN EXPLICIT `aria-label`, BECAUSE BELOW THE RUNG ITS ONLY
 * CONTENT IS AN ICON — i.e. it would be named by nothing. `aria-label` overrides visible
 * text, so the review button's label is the EXACT string its wide form shows; a label
 * that merely paraphrased the visible word would break "label in name" for anyone
 * driving this by voice. The dismiss button keeps the longer label it already had.
 *
 * 🔴 `events` IS SET ON BOTH TOOLTIPS AND IS NOT COSMETIC. Mantine's default is
 * `{ hover: true, focus: false, touch: false }` — so on the device class the narrow form
 * exists for, a touch user would get an icon with no visible text, no tooltip and no
 * hint, on the one control that lets a stuck viewer recover. Keyboard focus was equally
 * silent. ⚠️ The tooltip is a SIGHTED affordance only, and an earlier revision overstated
 * that as "wires NO aria at all": `useRole` does put `aria-describedby` on the reference
 * while the tooltip is OPEN. What it never provides is a NAME, which is why the explicit
 * `aria-label` above is the load-bearing half and this is the complement to it.
 * ⚠️ `openDelay` matches the rail's link tooltips (`AppsRailNav.tsx`) FOR A MOUSE-LIKE
 * POINTER ONLY — floating-ui returns a 0 delay otherwise, so a TAP opens immediately.
 * (Mouse-like deliberately includes `'pen'`, for the Chromium/Linux mice that report it,
 * so a stylus still waits the 300ms.) Immediate-on-tap is the behaviour you want here;
 * it is noted because "matches the rail" would otherwise read as unconditional.
 *
 * ⚠️ THE ROW STILL DOES NOT WRAP, DELIBERATELY. `wrap="nowrap"` is kept and the MESSAGE
 * is given `min-w-0` instead, so the sentence shrinks and wraps while the actions stay
 * beside it at full size. A wrapping row would drop the recovery buttons below the text
 * and make the bar taller, which is the thing being fixed. Between the rung and roughly
 * 700px the wide form therefore still wraps the sentence onto two lines — far short of
 * the six it wrapped onto at 390px before, and the correct behaviour for that width.
 */
export function BlockConsentNotice({ appName, onReview, onDismiss }: BlockConsentNoticeProps) {
  return (
    <Box
      role="status"
      data-testid="block-consent-notice"
      className="@container"
      px="md"
      py="xs"
      style={{
        borderBottom: '1px solid var(--mantine-color-default-border)',
        background: 'var(--mantine-color-body)',
      }}
    >
      <Group justify="space-between" wrap="nowrap" gap="sm" align="center">
        {/* `min-w-0`: a flex item's automatic minimum size is its min-content width, so
            without this the sentence floors the row at its longest word-run and pushes
            the actions out instead of wrapping. */}
        <Text size="sm" className="min-w-0">
          {/* CLIPPED below the rung, not removed — see the a11y note above. */}
          <span className="@max-xs:sr-only" data-form="wide">
            {appName ?? 'This app'} is missing permissions it needs to work fully.
          </span>
          {/* Short, and deliberately WITHOUT the app name: this bar renders directly
              above the app it is about, so the name is the one word the narrow form can
              drop without losing the referent. `aria-hidden` because the sentence above
              is still in the tree at this width and only one of them may be announced. */}
          <span className="@xs:hidden" data-form="narrow" aria-hidden>
            Missing permissions
          </span>
        </Text>
        <Group gap="xs" wrap="nowrap" className="shrink-0">
          <Tooltip
            label="Review permissions"
            withArrow
            openDelay={300}
            events={{ hover: true, focus: true, touch: true }}
          >
            <Button
              size="compact-sm"
              variant="light"
              aria-label="Review permissions"
              data-testid="block-consent-notice-review"
              onClick={onReview}
            >
              <IconShieldCheck size={16} className="@xs:hidden" data-form="narrow" />
              <span className="@max-xs:hidden" data-form="wide">
                Review permissions
              </span>
            </Button>
          </Tooltip>
          <Tooltip
            label="Dismiss"
            withArrow
            openDelay={300}
            events={{ hover: true, focus: true, touch: true }}
          >
            <Button
              size="compact-sm"
              variant="subtle"
              aria-label="Dismiss the missing-permissions notice"
              data-testid="block-consent-notice-dismiss"
              onClick={onDismiss}
            >
              <IconX size={16} className="@xs:hidden" data-form="narrow" />
              <span className="@max-xs:hidden" data-form="wide">
                Dismiss
              </span>
            </Button>
          </Tooltip>
        </Group>
      </Group>
    </Box>
  );
}
