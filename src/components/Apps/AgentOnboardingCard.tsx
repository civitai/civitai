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
} from '~/components/Apps/agentOnboardingMotion';
import { AGENT_BUILD_PROMPT } from '~/components/Apps/cliCommands';
import { CopyAffordance, CopyGlyph } from '~/components/CopyAffordance/CopyAffordance';
import classes from './AgentOnboardingCard.module.scss';

/** Stable handles for the three placements' assertions. */
export const AGENT_ONBOARDING_TESTID = 'apps-agent-onboarding';
export const AGENT_PROMPT_TESTID = 'apps-agent-onboarding-prompt';
export const AGENT_CARET_TESTID = 'apps-agent-onboarding-caret';
/** The 1px gradient ring — present in BOTH trees; read `animation-name`, see {@link Ring}. */
export const AGENT_SHIMMER_TESTID = 'apps-agent-onboarding-shimmer';
/** One per staggered row, carrying its index — present in the animated tree only. */
export const AGENT_ROW_TESTID = 'apps-agent-onboarding-row';
/** The glyph's scale-pop wrapper — present in the animated tree only. */
export const AGENT_GLYPH_TESTID = 'apps-agent-onboarding-glyph';

/** The copy control's accessible name. Exported so the suites name it rather than retype it. */
export const AGENT_COPY_LABEL = 'Copy the agent setup prompt';

/**
 * 🔴 DEFINED HERE RATHER THAN IMPORTED FROM `~/components/Chat/util`, which exports an
 * identical `loadMotion`. Importing Chat's copy would drag `linkifyjs` and the chat renderers
 * into the `/apps` route graph for the sake of one dynamic import; the thing that must not be
 * duplicated — the feature bundle — stays single-sourced in `~/utils/lazy-motion`, which
 * cannot host this line without landing in the importer's chunk.
 */
const loadMotion = () => import('~/utils/lazy-motion').then((res) => res.default);

/**
 * "Let your agent build it" — the copyable onboarding prompt for `/apps/build`.
 *
 * Mounted in all THREE of `AppsBuildBody`'s states: the public pitch (inside
 * {@link GetStartedBody}), the first-app quickstart (beside the three CLI commands), and the
 * workbench's collapsed "Developer resources" strip.
 *
 * Pure presentational — props-only, no tRPC, no tracker import; the funnel event arrives as
 * `onCopy` from `AppsBuildBody`, the one call site with a tracker, which is what keeps
 * `GetStartedBody` provider-free as its own header promises. ⚠️ One asterisk on that header's
 * "no network": the ANIMATED tree renders `LazyMotion`, which fetches a same-origin runtime
 * chunk. Nothing is sent, and the static tree fetches nothing.
 *
 * The prompt is deliberately not upstream's — see `./cliCommands`'s {@link AGENT_BUILD_PROMPT}.
 *
 * ── MOTION ──────────────────────────────────────────────────────────────────────
 * A staggered row entrance and the glyph's scale pop (`motion`, finite), a blinking caret
 * (`motion`, infinite), and a ~4s gradient shimmer on the 1px ring (CSS keyframes, in
 * `./AgentOnboardingCard.module.scss`). The prompt's own characters are deliberately NOT typed
 * out — it is text the reader has to read and copy.
 *
 * 🔴 BEFORE ADDING ANY `repeat: Infinity` ANIMATION HERE, CHECK ITS KEY IS LITERALLY IN
 * framer's `acceleratedValues` — `{opacity, clipPath, filter, transform}`, and the key is
 * passed UNNORMALISED, so `y` and `scale` are NOT members. A slow infinite `rotate` or a
 * pulsing `scale` reproduces the shimmer bug verbatim while looking like it is on the safe
 * side of "transform and opacity"; the stylesheet's header has the mechanism and the reason
 * the shimmer had to leave `motion`. Finite one-shots are free whatever their key, because
 * their driver stops on completion — which is why the entrance and the pop stay here.
 * Guarded by `__tests__/agentOnboardingMotion.test.ts`, which walks this file's own source as
 * well as the motion module's exports.
 *
 * 🔴 `motion` IS LOADED LAZILY BECAUSE THE PITCH STATE IS INDEXABLE — the only PUBLIC state of
 * `/apps/build` (`build.tsx` sets `deIndex={isAuthor}`), and before this component `motion` was
 * not in the `/apps` route graph at all. `strict` makes a plain `motion.*` added here fail
 * loudly rather than silently re-link the runtime. ⚠️ Lazy is not free, and the price is
 * recorded so it can be weighed rather than rediscovered (esbuild over the installed
 * `motion@11.18.2`, react externalised, minified + gzip -9): the STATIC half — `LazyMotion`
 * plus the two `motion/react-m` elements, both module-scope imports — is **6,586 B gz**, paid
 * by every visitor in all three states; the DEFERRED half is **18,302 B gz**. A naive
 * `import { motion }` would be 37,270 B gz, all static.
 *
 * 🔴 THE ENTRANCE MOVES `y` AND NEVER `opacity` — A CORRECTNESS CHOICE, NOT A TASTE ONE,
 * because `m` applies `initial` as a STATIC style: an `opacity: 0` entrance ships an INVISIBLE
 * card in the indexed HTML. Reasoning and guard: `./agentOnboardingMotion`'s
 * {@link REVEAL_INITIAL} and its test.
 *
 * 🔴 `useReducedMotion(true)` — THE ARGUMENT IS THE SSR DEFAULT, AND IT IS DELIBERATE.
 * Mantine's hook wraps `useMediaQuery`, which has no server answer; `true` makes the server and
 * the first client paint render the STATIC tree, so the indexed HTML carries no motion markup
 * and the animated tree is something the client opts into. `PageBlockHost` passes the same
 * argument for the same reason. Consequence for tests: `off` is every card's first-commit
 * value, so a static assertion must settle the effect first — each suite's header says so.
 *
 * ⚠️ `useReducedMotion` IS NOT IN `local-rules/no-ssr-divergent-media-query`'S BANNED SET, AND
 * THAT IS THE DECISION, NOT AN OVERSIGHT. `useReducedMotion(true)` already IS the SSR-safe
 * shape that rule exists to force, and the rule has no discriminator for a hook given an
 * explicit SSR default — it would red this call and need a disable comment on correct code.
 * Enrolling it means adding the name to that rule's `SSR_DIVERGENT_HOOKS`, which is the only
 * widening path there is; an earlier draft of this paragraph justified the decision on the
 * rule being UNABLE to see the hook, which was false.
 *
 * 🔴 UNDER REDUCED MOTION — OR `animated={false}` — THE TREE SHORT-CIRCUITS TO PLAIN DOM: no
 * `LazyMotion`, no `m` components, no caret, no `.ringAnimated`. The pattern `wizardMotion`
 * established, and it keeps the reduced-motion DOM cheap to assert. The ring still paints its
 * gradient from CSS at a fixed `background-position`, and the copy affordance is the same
 * `CopyAffordance` in both trees.
 *
 * ⚠️ TWO ACCEPTED COSTS OF THE TWO-TREE STRUCTURE. (a) The element type changes at the root and
 * at each row, so React remounts the card's ~40 nodes one commit after hydration —
 * sub-millisecond, one tick. (b) The caret is inline content in the animated tree only, so it
 * can push the prompt's last word onto a new line: ~0.009 CLS, an order of magnitude under the
 * 0.1 threshold. Reserving its box was declined — `animation-name` is time-invariant and a
 * blink's opacity is not, so it would buy the box at the cost of the caret's only crisp guard.
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
 * 🔴 A PLAIN `div` IN BOTH TREES, AND THE SHIMMER IS A CLASS — not a `motion` component, since
 * `background-position` is the one property here framer cannot hand to the compositor. So this
 * node's PRESENCE is evidence of nothing: read its computed `animation-name`.
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
 * ⚠️ THAT IS ALL THE INDEX SET PINS — it says nothing about the DELAY, which could be
 * flattened to 0 with the whole browser suite green. The delay is pinned in
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
