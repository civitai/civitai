import { Button, Text } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import { IconAlertTriangle, IconCheck } from '@tabler/icons-react';
import { LazyMotion } from 'motion/react';
import { div as MotionDiv } from 'motion/react-m';
import { useEffect, useRef } from 'react';
import { CrucibleContentBadges } from '~/components/Crucible/CrucibleContentBadges';
import { JUDGING_RULES } from '~/components/Crucible/judging-rules';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import {
  browsingLevelLabels,
  parseBitwiseBrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';
import type { MediaType } from '~/shared/utils/prisma/enums';

const loadMotion = () => import('~/utils/lazy-motion').then((res) => res.default);
// The arena's own hotkeys. Not swallowed here, so the press that closes the card still does its job.
const DISMISS_KEYS = new Set(['Escape', '1', '2', 'ArrowLeft', 'ArrowRight', ' ']);

type Props = {
  name: string;
  theme: string;
  image?: { url: string; name?: string | null } | null;
  contentType: MediaType;
  nsfwLevel: number;
  /** The judge's browsing level, to say whether their settings show everything the crucible allows. */
  browsingLevel: number;
  onDismiss: () => void;
};

/** Shown once per crucible over the dimmed arena. */
export function CrucibleJudgingBriefing({
  name,
  theme,
  image,
  contentType,
  nsfwLevel,
  browsingLevel,
  onDismiss,
}: Props) {
  const motionOn = !useReducedMotion(true);
  const startRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    startRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (DISMISS_KEYS.has(e.key)) onDismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onDismiss]);

  const highest = Math.max(0, ...parseBitwiseBrowsingLevel(nsfwLevel));
  const highestLabel = browsingLevelLabels[highest as keyof typeof browsingLevelLabels];
  const showsAll = (browsingLevel & nsfwLevel) === nsfwLevel;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-start justify-center overflow-y-auto p-4 md:items-center">
      <LazyMotion features={loadMotion} strict>
        {/* Scale and lift only: an opacity entrance would hide the card if the motion chunk fails. */}
        <MotionDiv
          role="dialog"
          aria-modal="true"
          aria-label={`How judging ${name} works`}
          className="pointer-events-auto flex w-full max-w-[560px] flex-col gap-3 rounded-xl border border-[#373a40] bg-[#25262b] p-5 shadow-2xl"
          initial={motionOn ? { scale: 0.96, y: 8 } : false}
          animate={{ scale: 1, y: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          <div className="flex items-center gap-3">
            {image && (
              <div className="size-14 shrink-0 overflow-hidden rounded-lg bg-[#2C2E33]">
                <EdgeMedia
                  src={image.url}
                  name={image.name}
                  type="image"
                  width={112}
                  className="size-full object-cover"
                />
              </div>
            )}
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="min-w-0 text-lg font-bold leading-tight text-white [overflow-wrap:anywhere]">
                {name}
              </h2>
              <CrucibleContentBadges contentType={contentType} nsfwLevel={nsfwLevel} />
            </div>
          </div>

          {theme && (
            <Text size="sm" c="dimmed" lineClamp={4} className="[overflow-wrap:anywhere]">
              {theme}
            </Text>
          )}

          {highestLabel && (
            <div className="flex items-start gap-2 rounded-lg bg-yellow-500/10 p-2.5 text-sm text-yellow-300">
              <IconAlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>
                Entries here go up to {highestLabel}, and your browsing settings{' '}
                {showsAll ? 'show all of it.' : 'hide some of it.'}
              </span>
            </div>
          )}

          <ul className="flex flex-col gap-1.5 text-sm text-[#c1c2c5]">
            {JUDGING_RULES.map((rule) => (
              <li key={rule} className="flex items-start gap-2">
                <IconCheck size={16} className="mt-0.5 shrink-0 text-green-400" />
                <span>{rule}</span>
              </li>
            ))}
          </ul>

          <div className="pt-1">
            <Button ref={startRef} fullWidth onClick={onDismiss}>
              Start judging
            </Button>
          </div>
        </MotionDiv>
      </LazyMotion>
    </div>
  );
}
