import { Badge, Button, Card, Group, Modal, Text } from '@mantine/core';
import clsx from 'clsx';
import type { RevealTier } from '~/components/CreatorJourney/milestone-rarity';
import {
  rarityLabel,
  revealTier,
  splitReveals,
} from '~/components/CreatorJourney/milestone-rarity';
import { accentVar, TierBadge } from '~/components/CreatorJourney/tier-badge';
import type { RouterOutput } from '~/types/router';
import { numberWithCommas } from '~/utils/number-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import classes from './MilestoneReveal.module.scss';

type Reveal = RouterOutput['creatorJourney']['getMine']['reveals'][number];

const ROW_LIMIT = 5;

const tierColors: Record<RevealTier, { label: string; color: string }> = {
  common: { label: 'Common', color: 'gray' },
  rare: { label: 'Rare', color: 'blue' },
  epic: { label: 'Epic', color: 'grape' },
  special: { label: 'Special', color: 'violet' },
};

const tierStyle = (tier: RevealTier) => {
  const { label, color } = tierColors[tier];
  return { label, color, accent: `var(--mantine-color-${color}-6)` };
};

function subtitle(reveal: Reveal) {
  if (reveal.track === 'score' && reveal.threshold != null)
    return `Creator Score ${numberWithCommas(reveal.threshold)}`;
  return reveal.hint ?? reveal.description;
}

/**
 * Unlocks the owner has not seen yet: a few full-screen moments for the rarest, and one row with a
 * single "Got it" for the rest. Dismissing marks them seen.
 */
export function MilestoneReveals({ reveals }: { reveals: Reveal[] }) {
  const utils = trpc.useUtils();
  const markSeen = trpc.creatorJourney.markRevealsSeen.useMutation({
    // The reveal stays dismissed until the journey is next fetched, then comes back.
    onError: (error) =>
      showErrorNotification({ title: 'Could not save that', error: new Error(error.message) }),
  });

  const { modals: big, row: small } = splitReveals(reveals);

  const dismiss = (dismissing: Reveal[]) => {
    if (!dismissing.length) return;
    const keys = new Set(dismissing.map((reveal) => reveal.key));
    // Dropped from the cached journey, not local state: the journey never refetches on its own, so a
    // return visit would otherwise replay every dismissed reveal.
    utils.creatorJourney.getMine.setData(
      undefined,
      (journey) =>
        journey && {
          ...journey,
          reveals: journey.reveals.filter((reveal) => !keys.has(reveal.key)),
        }
    );
    markSeen.mutate({ keys: [...keys] });
  };

  return (
    <>
      {small.length > 0 && <RevealRow reveals={small} onDismiss={() => dismiss(small)} />}
      {big.length > 0 && (
        <RevealModal
          // A new key per reveal replays the entrance.
          key={big[0].key}
          reveal={big[0]}
          remaining={big.length}
          onNext={() => dismiss([big[0]])}
          onSkipAll={() => dismiss(big)}
        />
      )}
    </>
  );
}

function RevealRow({ reveals, onDismiss }: { reveals: Reveal[]; onDismiss: () => void }) {
  const shown = reveals.slice(0, ROW_LIMIT);
  const more = reveals.length - shown.length;
  return (
    <Card withBorder radius="lg" p="sm">
      <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={6}>
        New unlocks
      </Text>
      <div className="flex flex-wrap items-center gap-2">
        {shown.map((reveal, index) => {
          const { accent } = tierStyle(revealTier(reveal));
          const label = rarityLabel(reveal.rarity);
          return (
            <div
              key={reveal.key}
              className={clsx(
                classes.pill,
                'flex items-center gap-2 rounded-full border border-solid py-1 pl-1 pr-3'
              )}
              style={{
                ...accentVar(accent),
                borderColor: 'color-mix(in srgb, var(--cj-accent) 50%, transparent)',
                animationDelay: `${index * 0.1}s`,
              }}
            >
              <TierBadge name={reveal.name} badgeUrl={reveal.badgeUrl} state="earned" size={32} />
              <div className="leading-tight">
                <Text size="sm" fw={700}>
                  {reveal.name}
                </Text>
                {label && (
                  <Text size="xs" c="dimmed">
                    {label}
                  </Text>
                )}
              </div>
            </div>
          );
        })}
        {more > 0 && (
          <Text size="sm" c="dimmed">
            and {more} more
          </Text>
        )}
        <Button size="xs" variant="default" onClick={onDismiss} className="ml-auto">
          Got it
        </Button>
      </div>
    </Card>
  );
}

function RevealModal({
  reveal,
  remaining,
  onNext,
  onSkipAll,
}: {
  reveal: Reveal;
  remaining: number;
  onNext: () => void;
  onSkipAll: () => void;
}) {
  const tier = revealTier(reveal);
  const { label, color, accent } = tierStyle(tier);
  const rarity = rarityLabel(reveal.rarity);
  const sub = subtitle(reveal);

  return (
    <Modal
      opened
      onClose={onNext}
      withCloseButton={false}
      centered
      radius="lg"
      size="sm"
      padding={0}
      classNames={{ content: 'overflow-hidden' }}
      overlayProps={{ backgroundOpacity: 0.8 }}
      aria-label={`You unlocked ${reveal.name}`}
    >
      <div
        className="relative flex flex-col items-center gap-1 overflow-hidden px-6 py-8 text-center"
        style={accentVar(accent)}
      >
        {tier === 'epic' && <div aria-hidden className={classes.rays} />}
        <Badge variant="filled" color={color} className="relative">
          {label}
        </Badge>
        <TierBadge
          name={reveal.name}
          badgeUrl={reveal.badgeUrl}
          state="earned"
          size={120}
          className={clsx('relative my-3', tier === 'epic' ? classes.glow : classes.badge)}
        />
        <Text size="xs" tt="uppercase" c="dimmed" className="relative tracking-wider">
          You unlocked
        </Text>
        <Text fz={22} fw={900} className="relative">
          {reveal.name}
        </Text>
        {sub && (
          <Text c="dimmed" size="sm" className="relative">
            {sub}
          </Text>
        )}
        {rarity && (
          <Text fw={800} fz={18} className="relative mt-2" style={{ color: 'var(--cj-accent)' }}>
            {rarity}
          </Text>
        )}
        <Group justify="center" mt="md" className="relative">
          {remaining > 1 && (
            <Button variant="default" onClick={onSkipAll}>
              Skip all
            </Button>
          )}
          <Button color={color} onClick={onNext} data-autofocus>
            {remaining > 1 ? 'Next' : 'Nice'}
          </Button>
        </Group>
      </div>
    </Modal>
  );
}
