import type { ReactNode } from 'react';
import { Group, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import { IconSparkles } from '@tabler/icons-react';
import { LazyMotion } from 'motion/react';
import { div as MotionDiv, span as MotionSpan } from 'motion/react-m';
import clsx from 'clsx';
import { AGENT_BUILD_PROMPT } from '~/components/Apps/cliCommands';
import { CopyAffordance, CopyGlyph } from '~/components/Apps/CopyAffordance';
import classes from './AgentOnboardingCard.module.scss';

/** Stable handles for the three placements' assertions. */
export const AGENT_ONBOARDING_TESTID = 'apps-agent-onboarding';
export const AGENT_PROMPT_TESTID = 'apps-agent-onboarding-prompt';
export const AGENT_CARET_TESTID = 'apps-agent-onboarding-caret';
export const AGENT_SHIMMER_TESTID = 'apps-agent-onboarding-shimmer';

/** The copy control's accessible name. Exported so the suites name it rather than retype it. */
export const AGENT_COPY_LABEL = 'Copy the agent setup prompt';

/** ~40ms between each row's entrance, in `motion`'s seconds. */
const STAGGER_SECONDS = 0.04;

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
 * Pure presentational — props-only, no tRPC, no network, no tracker import. The funnel event
 * is threaded in as `onCopy` from `AppsBuildBody`, the one call site that has a tracker,
 * exactly as `onCopyCommand` already is. That is what keeps `GetStartedBody` the
 * provider-free component its own header promises and its suite depends on.
 *
 * ── WHAT THE PROMPT IS, AND WHY IT IS NOT UPSTREAM'S ────────────────────────────
 * See `./cliCommands`'s {@link AGENT_BUILD_PROMPT} note. In short: upstream's canonical
 * prompt is setup-only and stops before authentication, so this one asks for the login state
 * back and then turns the session toward building. The URL inside it is a Cloudflare 302
 * tracked in neither repo — that constant's note is the only record of it.
 *
 * ── MOTION ──────────────────────────────────────────────────────────────────────
 * Four micro-interactions, all driven by `motion` (`^11`, already a dependency):
 *   1. a staggered row entrance, {@link STAGGER_SECONDS} apart;
 *   2. the clipboard glyph morphing to a check with a scale pop on copy;
 *   3. a ~4s gradient shimmer travelling around the card's 1px ring;
 *   4. a blinking caret after the settled prompt text.
 * The prompt's own characters are deliberately NOT typed out — it is text the reader has to
 * read and copy, and a typewriter effect makes both worse. The caret is decoration beside
 * settled text.
 *
 * 🔴 `motion` IS LOADED LAZILY, AND ON THIS ROUTE THAT IS A REQUIREMENT RATHER THAN A
 * COURTESY. `PageBlockHost` records the measurement behind it: `motion` is not in the
 * `/apps` route graph at all (its only importers are `src/components/Chat/*` plus
 * `~/utils/lazy-motion`, reached through a `next/dynamic` chunk), so a static import here
 * would pull a whole animation runtime into this bundle — and the pitch state is the only
 * PUBLIC, deliberately-indexable state of `/apps/build` (`build.tsx` sets
 * `deIndex={isAuthor}`). `LazyMotion` + `motion/react-m` keeps the runtime in its own chunk;
 * only the thin `m` components are statically linked. `strict` is set so a plain `motion.*`
 * component added here fails loudly instead of silently re-linking the runtime.
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
 * with no `LazyMotion`, no `m` components, no caret and no shimmer animation, which is the
 * pattern `wizardMotion` established and for the reason it gives: it keeps the
 * reduced-motion DOM identical to a plain render and cheap to assert. The ring still paints
 * its gradient (from CSS, at a fixed `background-position`), so the card still looks
 * designed rather than broken, and the copy affordance is untouched — it is the same
 * `CopyAffordance` in both trees.
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
      {tone === 'prominent'
        ? 'Paste this into Claude Code, Cursor, Codex or any coding agent. It installs the CLI, registers the Civitai MCP servers, tells you whether you still need to log in, then interviews you about your idea and builds it.'
        : 'Paste this into your coding agent instead — it runs the setup, then builds from your idea.'}
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

/** The 1px gradient ring. Animated: the gradient travels. Static: it just sits there. */
function Ring({ motionOn, children }: { motionOn: boolean; children: ReactNode }) {
  if (!motionOn) return <div className={classes.ring}>{children}</div>;
  return (
    <MotionDiv
      className={classes.ring}
      data-testid={AGENT_SHIMMER_TESTID}
      // The gradient and its 200%-wide `background-size` are in the stylesheet; only the
      // position is animated, so a static render keeps a correct-looking edge.
      animate={{ backgroundPosition: ['0% 50%', '200% 50%'] }}
      transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
    >
      {children}
    </MotionDiv>
  );
}

/**
 * One row of the staggered entrance.
 *
 * Static returns the child UNWRAPPED, so the reduced-motion DOM is a plain render — the
 * property `wizardMotion` wanted and the reason its own reduced-motion branch short-circuits.
 * Layout is unchanged either way: wrapped or not, each row is exactly one flex child of the
 * same `Stack`, so the gaps do not move.
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
      initial={{ y: 6 }}
      animate={{ y: 0 }}
      transition={{ duration: 0.3, delay: index * STAGGER_SECONDS, ease: 'easeOut' }}
    >
      {children}
    </MotionDiv>
  );
}

/**
 * The copyable prompt.
 *
 * 🔴 THE WHOLE PANEL IS THE CLICK TARGET AND THE ICON IS THE KEYBOARD TARGET, which is
 * `CopyAffordance`'s shape rather than anything new here — including the
 * `stopPropagation()` that stops an icon press firing `onCopy` twice. The icon is a real
 * `<button>` (Mantine `ActionIcon`), so Tab reaches it and Enter/Space operate it.
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
                animate={{ scale: [1, 1.25, 1] }}
                transition={{ duration: 0.28, ease: 'easeOut' }}
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
                animate={{ opacity: [1, 0] }}
                transition={{
                  duration: 0.55,
                  repeat: Infinity,
                  repeatType: 'reverse',
                  ease: 'linear',
                }}
              />
            )}
          </Text>
        </div>
      )}
    </CopyAffordance>
  );
}
