import type { ReactNode } from 'react';
import { Group, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import { IconSparkles } from '@tabler/icons-react';
import { LazyMotion } from 'motion/react';
import { div as MotionDiv, span as MotionSpan } from 'motion/react-m';
import clsx from 'clsx';
import {
  CARET_BLINK_ANIMATE,
  CARET_BLINK_TRANSITION,
  GLYPH_POP_ANIMATE,
  GLYPH_POP_TRANSITION,
  REVEAL_ANIMATE,
  REVEAL_INITIAL,
  revealTransition,
  STAGGER_SECONDS,
} from '~/components/Apps/agentOnboardingMotion';
import { AGENT_BUILD_PROMPT } from '~/components/Apps/cliCommands';
import { CopyAffordance, CopyGlyph } from '~/components/Apps/CopyAffordance';
import classes from './AgentOnboardingCard.module.scss';

/** Stable handles for the three placements' assertions. */
export const AGENT_ONBOARDING_TESTID = 'apps-agent-onboarding';
export const AGENT_PROMPT_TESTID = 'apps-agent-onboarding-prompt';
export const AGENT_CARET_TESTID = 'apps-agent-onboarding-caret';
/**
 * The 1px gradient ring.
 *
 * 🔴 PRESENT IN BOTH TREES — so its mere EXISTENCE says nothing about motion. The ring is a
 * plain `div` either way and the shimmer is a CSS class on it, so the assertable state is
 * its computed `animation-name`, not whether the node is there. A suite that reads the
 * presence of this testid as "the shimmer runs" is asserting nothing.
 */
export const AGENT_SHIMMER_TESTID = 'apps-agent-onboarding-shimmer';
/** One per staggered row, carrying its index — present in the animated tree only. */
export const AGENT_ROW_TESTID = 'apps-agent-onboarding-row';
/** The glyph's scale-pop wrapper — present in the animated tree only. */
export const AGENT_GLYPH_TESTID = 'apps-agent-onboarding-glyph';

/** The copy control's accessible name. Exported so the suites name it rather than retype it. */
export const AGENT_COPY_LABEL = 'Copy the agent setup prompt';

/**
 * Re-exported from `./agentOnboardingMotion`, where it is pinned in the `unit` tier along
 * with the delay it is multiplied into — asserting the constant alone let a flattened stagger
 * through a fully green suite.
 */
export { STAGGER_SECONDS };

/**
 * 🔴 DEFINED HERE RATHER THAN IMPORTED FROM `~/components/Chat/util`, WHICH ALREADY EXPORTS
 * AN IDENTICAL `loadMotion`. The duplicated thing is a one-line dynamic import; the thing
 * that must not be duplicated — the feature bundle itself — stays single-sourced in
 * `~/utils/lazy-motion`. Importing Chat's copy would drag `linkifyjs`, the chat link
 * renderers and the chat types into the `/apps` route graph for the sake of that one line,
 * which is a far worse trade than restating the loader. (It cannot live in
 * `~/utils/lazy-motion` either: a module cannot lazily import itself without landing in the
 * importer's chunk, which is the whole point of the split.)
 */
const loadMotion = () => import('~/utils/lazy-motion').then((res) => res.default);

/**
 * "Let your agent build it" — the copyable onboarding prompt for `/apps/build`.
 *
 * Mounted in all THREE of `AppsBuildBody`'s states, at three different prominences: the
 * public pitch (inside {@link GetStartedBody}, below the hero), the first-app quickstart
 * (beside the three CLI commands, as the alternative route), and the workbench's collapsed
 * "Developer resources" strip.
 *
 * Pure presentational — props-only, no tRPC, no tracker import. The funnel event is threaded
 * in as `onCopy` from `AppsBuildBody`, the one call site that has a tracker, exactly as
 * `onCopyCommand` already is. That is what keeps `GetStartedBody` the provider-free component
 * its own header promises and its suite depends on.
 *
 * ⚠️ ONE EXCEPTION TO "NO NETWORK", STATED RATHER THAN LEFT TO BE DISCOVERED: the ANIMATED
 * tree renders `LazyMotion`, which fetches the `~/utils/lazy-motion` chunk. That is a
 * same-origin runtime chunk and not an API call — nothing is sent, nothing is authenticated,
 * and the static tree issues none — but `GetStartedBody`'s header says "no tRPC / no network"
 * flatly, and after this component is mounted inside it that sentence has an asterisk.
 *
 * ── WHAT THE PROMPT IS, AND WHY IT IS NOT UPSTREAM'S ────────────────────────────
 * See `./cliCommands`'s {@link AGENT_BUILD_PROMPT} note. In short: upstream's canonical
 * prompt is setup-only and stops before authentication, so this one asks for the login state
 * back and then turns the session toward building. The URL inside it is a Cloudflare 302
 * tracked in neither repo — that constant's note is the only record of it.
 *
 * ── MOTION ──────────────────────────────────────────────────────────────────────
 * Four micro-interactions:
 *   1. a staggered row entrance, {@link STAGGER_SECONDS} apart      — `motion`
 *   2. the clipboard glyph morphing to a check with a scale pop     — `motion`
 *   3. a blinking caret after the settled prompt text               — `motion`
 *   4. a ~4s gradient shimmer travelling around the card's 1px ring — CSS keyframes
 * The prompt's own characters are deliberately NOT typed out — it is text the reader has to
 * read and copy, and a typewriter effect makes both worse. The caret is decoration beside
 * settled text.
 *
 * 🔴 THE SPLIT IN THAT LIST IS THE WHOLE PERFORMANCE STORY, AND THE RULE IS NARROWER THAN
 * "TRANSFORM AND OPACITY ARE FREE" — which is what this paragraph said until a review read
 * the installed source. `acceleratedValues` holds the LITERAL keys
 * `{opacity, clipPath, filter, transform}`, and framer passes the motion-value key
 * UNNORMALISED, so `y` and `scale` are NOT in it: the row entrance and the glyph pop take the
 * same main-thread animator the shimmer did. They are free anyway, for the other half of the
 * rule — they are FINITE one-shots (0.3s × 3 rows at mount, 0.28s per copy), and
 * `MainThreadAnimation` stops its driver and drops it on completion.
 *
 * So the dividing line is BOTH conditions, not either: the shimmer was costly because it was
 * non-accelerable AND `repeat: Infinity`, which makes its frameloop driver register with
 * `keepAlive: true` and never unregister. The caret is infinite and fine because its key is
 * literally `opacity`, so it hands off to `element.animate(…)` and runs compositor-side.
 *
 * 🔴 THE PRACTICAL INSTRUCTION, because the old wording would have licensed the exact bug it
 * existed to prevent: BEFORE ADDING ANY `repeat: Infinity` ANIMATION HERE, check its key is
 * literally in that four-item set. A slow infinite `rotate`, or a pulsing `scale`, reproduces
 * the shimmer bug verbatim while looking like it is on the safe side of "transform and
 * opacity". The shimmer itself lives in `./AgentOnboardingCard.module.scss`; do not move it
 * back into a `motion` `animate` prop.
 *
 * 🔴 `motion` IS LOADED LAZILY, AND ON THIS ROUTE THAT IS A REQUIREMENT RATHER THAN A
 * COURTESY. The pitch state is the only PUBLIC, deliberately-indexable state of `/apps/build`
 * (`build.tsx` sets `deIndex={isAuthor}`), and before this component `motion` was not in the
 * `/apps` route graph at all — see the now-amended note on `PageBlockHost`'s
 * `LAUNCH_REVEAL_MS`, which chose a plain CSS transition for exactly that reason and which
 * this component is the first exception to. `LazyMotion` + `motion/react-m` keeps the feature
 * bundle in its own chunk; `strict` is set so a plain `motion.*` added here fails loudly
 * instead of silently re-linking the runtime.
 *
 * ⚠️ "LAZY" IS NOT "FREE", AND THE HONEST NUMBERS ARE THESE (esbuild over the installed
 * `motion@11.18.2`, react externalised, minified + gzip -9; esbuild-measured, not
 * webpack-measured): the STATIC half — `LazyMotion` plus the two `motion/react-m` elements —
 * is **6,586 B gz** and is paid by every visitor in all three states, reduced-motion viewers
 * and the collapsed strip included, because lines 5-6 are module-scope imports. The DEFERRED
 * half is **18,302 B gz** and is fetched only when the animated tree mounts. The
 * counterfactual — a naive `import { motion }` — is 37,270 B gz all static, so the split
 * keeps ~30.7 KB gz off the critical path. The 6,586 B is the price of this decision; it is
 * recorded here so a future reader can weigh it rather than rediscover it.
 *
 * 🔴 THE ENTRANCE MOVES `y` AND NEVER `opacity`, WHICH IS A CORRECTNESS CHOICE AND NOT A
 * TASTE ONE. `m` components apply `initial` as a STATIC style — that is how framer SSRs an
 * animation's start state — so an `opacity: 0` entrance would put `opacity: 0` in the HTML a
 * crawler reads and leave the card INVISIBLE for as long as the lazy chunk takes, or
 * forever if hydration never completes. A 6px `translateY` has the same no-layout-shift
 * property (transforms do not reflow) and degrades to "content sits 6px low", which is
 * invisible to a reader and harmless to a crawler.
 *
 * 🔴 `useReducedMotion(true)` — THE ARGUMENT IS THE SSR DEFAULT, AND IT IS DELIBERATE.
 * Mantine's hook is a `useMediaQuery` wrapper, and a media query cannot be evaluated on the
 * server; passing `true` makes the server and the first client paint render the STATIC tree,
 * so the indexed HTML carries no motion markup at all and the animated tree is something the
 * client opts into. `PageBlockHost` passes the same argument for the same reason.
 * `wizardMotion`'s `useReducedMotion()` (defaulting false) is fine where it is used, because
 * the wizard is not server-rendered.
 *
 * 🔴 UNDER REDUCED MOTION — OR `animated={false}` — THE TREE SHORT-CIRCUITS TO PLAIN DOM
 * with no `LazyMotion`, no `m` components, no caret and no `.ringAnimated` class, which is
 * the pattern `wizardMotion` established and for the reason it gives: it keeps the
 * reduced-motion DOM identical to a plain render and cheap to assert. The ring still paints
 * its gradient (from CSS, at a fixed `background-position`), so the card still looks
 * designed rather than broken, and the copy affordance is untouched — it is the same
 * `CopyAffordance` in both trees.
 *
 * 🔴 BECAUSE THE DEFAULT ABOVE IS `true`, THE STATIC TREE IS ALSO WHAT EVERY CARD RENDERS ON
 * ITS FIRST COMMIT — AND THAT MAKES "IT IS STATIC" THE EASIEST VACUOUS ASSERTION IN THIS
 * FILE. Mantine's `useMediaQuery` returns the initial value on the first render and commits
 * the real one in an effect, so `motionOn` is false in the first commit of an ANIMATED card
 * too. Any test claiming this component is static must settle that effect first — `await` the
 * render, which drains it through `act` — or it is asserting the default rather than the
 * behaviour. Found by the test review, which measured a 50ms retry gap as the only thing
 * separating three such assertions from vacuous.
 *
 * ⚠️ TWO ACCEPTED COSTS OF THE TWO-TREE STRUCTURE. (a) The element type at the root and at
 * each row changes between the trees, so React remounts the card's ~40 nodes one commit after
 * hydration — sub-millisecond, and the window is a single tick. (b) The caret is inline
 * content present only in the animated tree, so it can push the prompt's last word onto a new
 * line: ~0.009 CLS, an order of magnitude under the 0.1 threshold. Reserving its box was
 * weighed and declined — the ring's both-trees shape works because `animation-name` is
 * time-invariant, and a blink's opacity is not, so it would buy the box at the cost of the
 * only crisp guard the caret has.
 */
export function AgentOnboardingCard({
  onCopy,
  animated = true,
  tone = 'prominent',
}: {
  /**
   * Fired on an ATTEMPTED copy of the prompt — see `CopyAffordance`'s `onCopy` doc. Receives
   * the exact bytes handed to the clipboard, which is {@link AGENT_BUILD_PROMPT}.
   */
  onCopy?: (value: string) => void;
  /**
   * Opt OUT of motion entirely.
   *
   * `false` in the workbench's collapsed strip. Mantine's `Collapse` keeps its children
   * MOUNTED at zero height, so an animated card there would run a 4s infinite shimmer and a
   * caret blink behind a panel nobody has opened, and would have finished its entrance
   * before the panel ever revealed it — paying for animation that cannot be seen. That strip
   * is documented as deliberately cheap (`GetStartedBody` is not even mounted in it), so it
   * stays cheap. This is the same code path reduced motion takes, not a second one.
   */
  animated?: boolean;
  /** Density. `prominent` leads the public pitch; `inline` sits beside other content. */
  tone?: 'prominent' | 'inline';
}) {
  const reduceMotion = useReducedMotion(true);
  const motionOn = animated && !reduceMotion;

  const rows: ReactNode[] = [
    <Group gap="xs" wrap="nowrap" align="center" key="heading">
      <ThemeIcon
        size={tone === 'prominent' ? 'lg' : 'md'}
        radius="md"
        variant="light"
        color="grape"
      >
        <IconSparkles size={tone === 'prominent' ? 20 : 16} />
      </ThemeIcon>
      {tone === 'prominent' ? (
        <Title order={3}>Let your agent build it</Title>
      ) : (
        <Text fw={600}>Or let your agent do it</Text>
      )}
    </Group>,
    <Text size="sm" c="dimmed" key="subtitle">
      {/*
        🔴 BOTH VARIANTS DISCLOSE THE SAME SIDE EFFECTS, AND THE SHORTER ONE IS NOT THE
        MINOR CASE. `inline` is what BOTH signed-in placements render, so it is the variant
        most readers actually see, and "it runs the setup" — the wording this replaced — named
        none of what the prompt makes an agent do on their machine. Both copies hand the agent
        byte-identical instructions, so both have to describe them.
      */}
      {tone === 'prominent'
        ? 'Paste this into Claude Code, Cursor, Codex or any coding agent. It installs the Civitai CLI, registers the Civitai MCP servers, tells you whether you still need to log in, then interviews you about your idea and builds it.'
        : 'Paste this into your coding agent instead — it installs the Civitai CLI, registers the MCP servers, tells you whether you still need to log in, then builds from your idea.'}
    </Text>,
    <PromptPanel motionOn={motionOn} onCopy={onCopy} key="prompt" />,
  ];

  const card = (
    <Ring motionOn={motionOn}>
      <div className={clsx(classes.surface, tone === 'prominent' ? 'p-4' : 'p-3')}>
        <Stack gap={tone === 'prominent' ? 'sm' : 'xs'}>
          {rows.map((row, index) => (
            <Reveal key={index} motionOn={motionOn} index={index}>
              {row}
            </Reveal>
          ))}
        </Stack>
      </div>
    </Ring>
  );

  const root = (
    <div data-testid={AGENT_ONBOARDING_TESTID} data-motion={motionOn ? 'on' : 'off'}>
      {card}
    </div>
  );

  if (!motionOn) return root;
  return (
    <LazyMotion features={loadMotion} strict>
      {root}
    </LazyMotion>
  );
}

/**
 * The 1px gradient ring. Animated: the gradient travels. Static: it just sits there.
 *
 * 🔴 A PLAIN `div` IN BOTH TREES, AND THE SHIMMER IS A CLASS. Not a `motion` component —
 * `background-position` is the one property here that framer cannot hand to the compositor;
 * see this component's header and the stylesheet's. The consequence for tests is that this
 * node's PRESENCE is not evidence of anything: read its computed `animation-name`.
 */
function Ring({ motionOn, children }: { motionOn: boolean; children: ReactNode }) {
  return (
    <div
      className={clsx(classes.ring, motionOn && classes.ringAnimated)}
      data-testid={AGENT_SHIMMER_TESTID}
    >
      {children}
    </div>
  );
}

/**
 * One row of the staggered entrance.
 *
 * Static returns the child UNWRAPPED, so the reduced-motion DOM is a plain render — the
 * property `wizardMotion` wanted and the reason its own reduced-motion branch short-circuits.
 * Layout is unchanged either way: wrapped or not, each row is exactly one flex child of the
 * same `Stack`, so the gaps do not move.
 *
 * 🔴 `data-reveal-index` IS WHAT MAKES THE STAGGER ASSERTABLE AT ALL. Without it, a mutation
 * that made this function always return `<>{children}</>` — i.e. deleted the entrance —
 * printed NOTHING across the whole suite: the root still said `data-motion="on"`, and the
 * caret and the ring were still there. The index is the thing the delay is computed from, so
 * an assertion over the set of indices pins both that the wrappers exist and how many rows
 * are staggered.
 *
 * ⚠️ THAT IS ALL THE INDEX SET PINS — it says nothing about the DELAY. This note used to add
 * "the duration constant is exported and asserted separately; between them the stagger has a
 * guard", and that was false: the constant was asserted against its own literal, so the
 * stagger could be flattened to `delay: 0` with the whole suite green. The delay is pinned in
 * `__tests__/agentOnboardingMotion.test.ts`, against `revealTransition` itself.
 */
function Reveal({
  motionOn,
  index,
  children,
}: {
  motionOn: boolean;
  index: number;
  children: ReactNode;
}) {
  if (!motionOn) return <>{children}</>;
  return (
    <MotionDiv
      data-testid={AGENT_ROW_TESTID}
      data-reveal-index={index}
      initial={REVEAL_INITIAL}
      animate={REVEAL_ANIMATE}
      transition={revealTransition(index)}
    >
      {children}
    </MotionDiv>
  );
}

/**
 * The copyable prompt.
 *
 * 🔴 THE CONTROL IS THE ONLY COPY TARGET — the prose body is deliberately not clickable
 * (`bodyClickCopies={false}`), because a body-wide click target fights text selection. The
 * control is a real `<button>` (Mantine `ActionIcon`), so Tab reaches it and Enter/Space
 * operate it.
 */
function PromptPanel({
  motionOn,
  onCopy,
}: {
  motionOn: boolean;
  onCopy?: (value: string) => void;
}) {
  return (
    <CopyAffordance
      value={AGENT_BUILD_PROMPT}
      label={AGENT_COPY_LABEL}
      onCopy={onCopy}
      iconClassName="absolute right-2 top-2"
      // Prose: the control is the only copy path. See `CopyAffordance`'s `bodyClickCopies`.
      bodyClickCopies={false}
      data-testid={AGENT_PROMPT_TESTID}
      renderGlyph={
        motionOn
          ? (copied) => (
              // Keyed on `copied` so the pop REPLAYS on each morph rather than once per
              // mount: framer plays `animate` on mount, and a remount is what makes the
              // clipboard→check swap pop.
              <MotionSpan
                key={String(copied)}
                className="flex"
                // 🔴 THE TESTID IS WHAT GIVES THE POP A GUARD. Deleting `renderGlyph`
                // entirely printed NOTHING across the suite before this: `CopyAffordance`'s
                // default renders the same two icons, so the morph still happened and only
                // the pop was gone. The wrapper's presence is the pop's only observable
                // structural trace.
                data-testid={AGENT_GLYPH_TESTID}
                animate={GLYPH_POP_ANIMATE}
                transition={GLYPH_POP_TRANSITION}
              >
                <CopyGlyph copied={copied} />
              </MotionSpan>
            )
          : undefined
      }
    >
      {() => (
        <div className={classes.panel}>
          {/* Padding lives in `classes.prompt`, NOT in a Tailwind `p-3` — the shorthand
              would reset the right padding that clears the copy control. */}
          <Text size="sm" ff="monospace" className={classes.prompt}>
            {AGENT_BUILD_PROMPT}
            {motionOn && (
              <MotionSpan
                className={classes.caret}
                data-testid={AGENT_CARET_TESTID}
                aria-hidden
                animate={CARET_BLINK_ANIMATE}
                transition={CARET_BLINK_TRANSITION}
              />
            )}
          </Text>
        </div>
      )}
    </CopyAffordance>
  );
}
