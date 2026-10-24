import { Badge, Button, Group, Progress, Stack, Text } from '@mantine/core';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { MysteryBoxArt } from '~/components/MysteryBox/MysteryBoxArt';
import MysteryBoxModal from '~/components/MysteryBox/MysteryBoxModal';
import { MysteryBoxOddsBar } from '~/components/MysteryBox/MysteryBoxOddsBar';
import type { MysteryBoxView } from '~/components/MysteryBox/mystery-box.utils';
import {
  boxActions,
  collectedCount,
  MYSTERY_BOX_FALLBACK_DESCRIPTION,
  tierSummaries,
} from '~/components/MysteryBox/mystery-box.utils';

/** A mystery box at the head of the team shelf: what it holds for you, your odds, and its buttons. */
export function MysteryBoxCard({
  event,
  view,
  color,
}: {
  event: string;
  view: MysteryBoxView;
  color: string;
}) {
  const [buzzType] = useAvailableBuzz();
  const { collected, total } = collectedCount(view);
  const actions = boxActions(view);
  const held = view.heldBoxItemIds.length;
  const show = (start?: 'buy' | 'open') =>
    dialogStore.trigger({
      component: MysteryBoxModal,
      props: { source: { event }, boxDefinitionId: view.boxDefinitionId, color, start },
    });

  return (
    <div
      className="grid grid-cols-1 items-center gap-4 rounded-xl border border-solid p-4 sm:grid-cols-[140px_1fr_auto]"
      style={{
        borderColor: actions.complete ? 'var(--mantine-color-yellow-6)' : color,
        background: `linear-gradient(120deg, color-mix(in srgb, ${color} 18%, transparent), transparent 60%)`,
      }}
      data-testid="mystery-box-card"
    >
      <MysteryBoxArt art={view.art} color={color} size={140} className="mx-auto" />
      <Stack gap={6}>
        <Group gap="xs">
          <Badge variant="filled" style={{ background: color }}>
            Mystery Box
          </Badge>
          {held > 0 && (
            <Badge variant="light" color="gray">
              {held} unopened
            </Badge>
          )}
        </Group>
        <Text fw={700} size="lg">
          {view.name}
        </Text>
        <Text size="sm" c="dimmed">
          {view.description ?? MYSTERY_BOX_FALLBACK_DESCRIPTION}
        </Text>
        <MysteryBoxOddsBar tiers={tierSummaries(view)} />
        <Group gap="sm" wrap="nowrap" mt={4}>
          <Progress
            value={total ? (collected / total) * 100 : 0}
            color={color}
            size="sm"
            className="max-w-72 flex-1"
            aria-label="Hats collected"
          />
          <Text size="xs" className="shrink-0">
            <b>{collected}</b> / {total} collected
          </Text>
        </Group>
      </Stack>
      <Stack gap="xs">
        <Button variant="light" onClick={() => show()} data-testid="box-look-inside">
          Look inside
        </Button>
        {actions.complete ? (
          <Badge size="lg" color="yellow" variant="light">
            Complete
          </Badge>
        ) : actions.canOpen ? (
          <Button onClick={() => show('open')} data-testid="box-card-open">
            Open your box
          </Button>
        ) : (
          actions.canBuy &&
          view.listing && (
            <BuzzTransactionButton
              buzzAmount={view.listing.unitAmount}
              accountTypes={[buzzType]}
              label="Buy and open"
              onPerformTransaction={() => show('buy')}
              data-testid="box-card-buy"
            />
          )
        )}
      </Stack>
    </div>
  );
}
