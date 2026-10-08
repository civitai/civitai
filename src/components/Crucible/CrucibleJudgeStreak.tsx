import { useReducedMotion } from '@mantine/hooks';
import { IconFlame } from '@tabler/icons-react';
import clsx from 'clsx';
import { AnimatePresence, LazyMotion } from 'motion/react';
import { div as MotionDiv, span as MotionSpan } from 'motion/react-m';
import { useEffect, useState } from 'react';
import {
  getStreakTier,
  isStreakBlazing,
  isStreakMilestone,
} from '~/components/Crucible/judging-streak';
import type { StreakTier } from '~/components/Crucible/judging-streak';
import { numberWithCommas } from '~/utils/number-helpers';

const loadMotion = () => import('~/utils/lazy-motion').then((res) => res.default);
const MILESTONE_TOAST_MS = 1600;
const ACCENT = '#FC9C2D';

type Props = {
  streak: number;
  /** Bumped each time a skip resets a running streak; 0 means it never has. */
  resetAt: number;
  className?: string;
};

const tierClass: Record<StreakTier, string> = {
  none: 'border-[#373A40] bg-[#25262b] text-[#909296]',
  warm: 'border-[#FC9C2D] bg-[#FC9C2D]/10 text-white',
  hot: 'border-[#FC9C2D] bg-[#FC9C2D]/15 text-white shadow-[0_0_12px_rgba(252,156,45,0.45)]',
  fire: 'border-transparent bg-gradient-to-r from-[#FC9C2D] to-[#FA5252] text-white shadow-[0_0_16px_rgba(250,82,82,0.5)]',
};
const blazingClass =
  'border-transparent bg-gradient-to-r from-[#FC9C2D] to-[#FA5252] text-white shadow-[0_0_24px_rgba(250,82,82,0.85)]';
const resetClass = 'border-[#373A40] bg-[#2C2E33] text-[#909296]';

export function CrucibleJudgeStreak({ streak, resetAt, className }: Props) {
  const motionOn = !useReducedMotion(true);
  // The streak only reaches 0 again through a skip, so 0 after a reset means "reset, no vote since".
  const isReset = streak === 0 && resetAt > 0;
  const tier = getStreakTier(streak);

  const [toastStreak, setToastStreak] = useState<number | null>(null);
  useEffect(() => {
    if (isStreakMilestone(streak)) setToastStreak(streak);
  }, [streak]);
  // Timed off the toast, not the streak: the next vote must not cancel the hide.
  useEffect(() => {
    if (toastStreak === null) return;
    const timeout = setTimeout(() => setToastStreak(null), MILESTONE_TOAST_MS);
    return () => clearTimeout(timeout);
  }, [toastStreak]);

  const flameColor = streak > 0 && tier !== 'fire' ? ACCENT : 'currentColor';
  const label = isReset
    ? 'Streak reset'
    : streak > 0
    ? `${numberWithCommas(streak)} in a row`
    : 'Vote to start a streak';

  return (
    <LazyMotion features={loadMotion} strict>
      <div className={clsx('relative inline-flex', className)}>
        {/* Beside the pill, not above it: the countdown sits above. Left of it from md, where the
            pill is right-aligned; right of it below md, where it is left-aligned. */}
        <div className="pointer-events-none absolute inset-y-0 left-full ml-2 flex items-center md:left-auto md:right-full md:ml-0 md:mr-2">
          <AnimatePresence>
            {toastStreak !== null && (
              <MotionDiv
                key={toastStreak}
                role="status"
                className="whitespace-nowrap rounded-full bg-gradient-to-r from-[#FC9C2D] to-[#FA5252] px-3 py-1 text-xs font-bold text-white shadow-lg"
                initial={motionOn ? { opacity: 0, y: 8 } : false}
                animate={{ opacity: 1, y: 0 }}
                exit={motionOn ? { opacity: 0, y: -8 } : { opacity: 0 }}
                transition={motionOn ? { duration: 0.25 } : { duration: 0 }}
              >
                On fire! {numberWithCommas(toastStreak)} in a row
              </MotionDiv>
            )}
          </AnimatePresence>
        </div>

        {/* Outside the remounting badge: a live region that remounts is not announced. */}
        <span aria-live="polite" className="inline-flex">
          <MotionDiv
            // Remounting on each reset replays the shake once per skip.
            key={resetAt}
            data-testid="judge-streak"
            className={clsx(
              'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-sm font-semibold transition-[background-color,border-color,box-shadow,color] duration-300',
              isReset ? resetClass : isStreakBlazing(streak) ? blazingClass : tierClass[tier]
            )}
            animate={isReset && motionOn ? { x: [0, -6, 6, -6, 6, -6, 6, 0] } : undefined}
            transition={{ duration: 0.45 }}
          >
            <MotionSpan
              // Keyed by the count so every vote replays the pop.
              key={streak}
              className="inline-flex"
              animate={streak > 0 && motionOn ? { scale: [1, 1.25, 1] } : undefined}
              transition={{ duration: 0.35 }}
            >
              <IconFlame
                size={16}
                color={flameColor}
                fill={streak > 0 ? flameColor : 'none'}
                fillOpacity={0.3}
              />
            </MotionSpan>
            {label}
          </MotionDiv>
        </span>
      </div>
    </LazyMotion>
  );
}
