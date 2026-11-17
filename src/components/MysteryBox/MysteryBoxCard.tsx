import { Badge, Button, Group, Progress, Stack, Text } from '@mantine/core';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { MysteryBoxArt } from '~/components/MysteryBox/MysteryBoxArt';
import MysteryBoxModal from '~/components/MysteryBox/MysteryBoxModal';
import { MysteryBoxOddsBar } from '~/components/MysteryBox/MysteryBoxOddsBar';
import type { MysteryBoxSource, MysteryBoxView } from '~/components/MysteryBox/mystery-box.utils';
import {
  boxActions,
  boxNoun,
  collectedCount,
  MYSTERY_BOX_FALLBACK_DESCRIPTION,
  MYSTERY_PACK_FALLBACK_DESCRIPTION,
  guaranteedTierSummaries,
  tierSummaries,
} from '~/components/MysteryBox/mystery-box.utils';
import { numberWithCommas } from '~/utils/number-helpers';

/** A mystery box at the head of the team shelf: what it holds for you, your odds, and its buttons. */
export function MysteryBoxCard({
  source,
  view,
  color,
}: {
  source: MysteryBoxSource;
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
      props: { source, boxDefinitionId: view.boxDefinitionId, color, start },
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
            {view.seller ? 'Mystery Pack' : 'Mystery Box'}
          </Badge>
          {view.listing && view.seller && (
            <Text size="sm" fw={700}>
              {numberWithCommas(view.listing.unitAmount)} Buzz
            </Text>
          )}
          {held > 0 && (
            <Badge variant="light" color="gray">
              {held} unopened
            </Badge>
          )}
        </Group>
        <Text fw={700} size="lg">
          {view.name}
        </Text>
        {view.seller && view.seller.username && (
          <Text size="xs" c="dimmed">
            Sold by @{view.seller.username}
          </Text>
        )}
        <Text size="sm" c="dimmed">
          {view.description ??
            (view.seller ? MYSTERY_PACK_FALLBACK_DESCRIPTION : MYSTERY_BOX_FALLBACK_DESCRIPTION)}
        </Text>
        <MysteryBoxOddsBar tiers={tierSummaries(view)} />
        <Group gap="sm" wrap="nowrap" mt={4}>
          <Progress
            value={total ? (collected / total) * 100 : 0}
            color={color}
            size="sm"
            className="max-w-72 flex-1"
            aria-label={`${boxNoun(view)}s collected`}
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

/**
 * A box's pack, listed as its own product beside the box: several boxes for one price, the first
 * guaranteed a rarer tier. Its boxes are the box's, so they are held and opened from the box's card.
 */
export function MysteryBoxPackCard({
  source,
  view,
  color,
}: {
  source: MysteryBoxSource;
  view: MysteryBoxView;
  color: string;
}) {
  const [buzzType] = useAvailableBuzz();
  const pack = view.packListing;
  if (!pack) return null;
  const actions = boxActions(view);
  const guaranteed = guaranteedTierSummaries(view, pack.guaranteedTierIds);
  const names = guaranteed.map((t) => t.tier.name).join(' or ');
  const freeBox = view.listing && pack.unitAmount === view.listing.unitAmount * (pack.size - 1);
  const show = (start?: 'buyPack') =>
    dialogStore.trigger({
      component: MysteryBoxModal,
      props: { source, boxDefinitionId: view.boxDefinitionId, color, start },
    });

  return (
    <div
      className="grid grid-cols-1 items-center gap-4 rounded-xl border border-solid p-4 sm:grid-cols-[140px_1fr_auto]"
      style={{
        borderColor: 'var(--mantine-color-yellow-6)',
        background: `linear-gradient(120deg, color-mix(in srgb, ${color} 18%, transparent), transparent 60%)`,
      }}
      data-testid="mystery-box-pack-card"
    >
      <MysteryBoxArt art={view.art} color={color} size={140} className="mx-auto" />
      <Stack gap={6}>
        <Group gap="xs">
          <Badge variant="filled" color="yellow">
            {pack.size}-pack
          </Badge>
          {freeBox && (
            <Badge variant="light" color="yellow">
              {pack.size}th box free
            </Badge>
          )}
        </Group>
        <Text fw={700} size="lg">
          {view.name} × {pack.size}
        </Text>
        <Text size="sm" c="dimmed">
          {pack.size} boxes for {numberWithCommas(pack.unitAmount)} Buzz. The first is guaranteed{' '}
          {names}; the other {pack.size - 1} use the box&apos;s usual odds.
        </Text>
      </Stack>
      <Stack gap="xs">
        <Button variant="light" onClick={() => show()} data-testid="box-pack-odds">
          See the odds
        </Button>
        {actions.canBuyPack ? (
          <BuzzTransactionButton
            color="yellow"
            buzzAmount={pack.unitAmount}
            accountTypes={[buzzType]}
            label={`Buy ${pack.size}`}
            onPerformTransaction={() => show('buyPack')}
            data-testid="box-card-buy-pack"
          />
        ) : (
          <Text size="xs" c="dimmed" ta="center" maw={180}>
            Not enough left in this box for you to buy a pack
          </Text>
        )}
      </Stack>
    </div>
  );
}
