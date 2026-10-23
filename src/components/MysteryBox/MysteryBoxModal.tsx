import {
  Anchor,
  Badge,
  Button,
  Center,
  CloseButton,
  Grid,
  Group,
  Loader,
  Modal,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useMemo, useRef } from 'react';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { HatArt } from '~/components/Events/ScoredEvent/HatArt';
import PlaceHatModal from '~/components/Events/ScoredEvent/PlaceHatModal';
import { MysteryBoxArt } from '~/components/MysteryBox/MysteryBoxArt';
import { MysteryBoxOddsBar } from '~/components/MysteryBox/MysteryBoxOddsBar';
import type {
  MysteryBoxSource,
  MysteryBoxView,
  TierSummary,
} from '~/components/MysteryBox/mystery-box.utils';
import {
  boxActions,
  boxEventOf,
  shelfPricesByCosmetic,
  collectedCount,
  formatChance,
  mysteryBoxOddsPageUrl,
  revealChance,
  tierColor,
  tierSummaries,
} from '~/components/MysteryBox/mystery-box.utils';
import type { OpenPhase } from '~/components/MysteryBox/useMysteryBoxOpen';
import { useMysteryBoxOpen, useMysteryBoxViews } from '~/components/MysteryBox/useMysteryBoxOpen';
import { useIsMobile } from '~/hooks/useIsMobile';
import { boxOpenClaimKey } from '@civitai/shared/mystery-box';
import type { EventDecorationFit } from '~/shared/constants/event-decoration.constants';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import styles from './MysteryBox.module.scss';

const PHASE_MESSAGE: Partial<Record<OpenPhase, string>> = {
  buying: 'Buying…',
  opening: 'Opening…',
};

/**
 * A box's contents and the viewer's odds, and where it is bought and opened. The odds are the
 * shared rule the draw uses, over what is left for the viewer, so they move as the viewer collects.
 */
export default function MysteryBoxModal({
  source,
  boxDefinitionId,
  color,
  start,
  boxItemId,
}: {
  source: MysteryBoxSource;
  boxDefinitionId: number;
  color: string;
  /** Start buying or opening as soon as it shows. */
  start?: 'buy' | 'open';
  boxItemId?: string;
}) {
  const dialog = useDialogContext();
  const isMobile = useIsMobile();
  const utils = trpc.useUtils();
  const [buzzType] = useAvailableBuzz();
  const { views, isLoading } = useMysteryBoxViews(source);
  const view = views?.find((v) => v.boxDefinitionId === boxDefinitionId);
  const event = boxEventOf(source, view);
  const opener = useMysteryBoxOpen(source);
  // The shelf's own query, to say when a reward is also sold there.
  const { data: shelf } = trpc.cosmeticShop.getShop.useQuery(
    { event: event ?? '' },
    { enabled: !!event }
  );
  const shelfPrices = useMemo(() => shelfPricesByCosmetic(shelf), [shelf]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current || !view || !start) return;
    started.current = true;
    if (start === 'buy') void opener.buyAndOpen(view);
    else void opener.openHeld(view, boxItemId);
  }, [view, start, opener, boxItemId]);

  const tiers = useMemo(() => (view ? tierSummaries(view) : []), [view]);
  const actions = view && (
    <BoxActions
      view={view}
      buzzType={buzzType}
      busy={opener.busy}
      onBuy={() => opener.buyAndOpen(view)}
      onOpen={() => opener.openHeld(view)}
    />
  );

  const placeReward = async () => {
    const result = opener.result;
    if (!result?.cosmeticId || !event) return dialog.onClose();
    await utils.event.getMyHats.invalidate({ event });
    const myHats = await utils.event.getMyHats.fetch({ event }, { staleTime: 0 });
    const hat = myHats.find(
      (h) => h.cosmeticId === result.cosmeticId && h.claimKey === boxOpenClaimKey(result.boxItemId)
    );
    dialog.onClose();
    if (hat) dialogStore.trigger({ component: PlaceHatModal, props: { event, hat, myHats } });
  };

  return (
    <Modal
      {...dialog}
      size="xl"
      radius="lg"
      fullScreen={isMobile}
      withCloseButton={false}
      classNames={{ body: 'p-0 relative' }}
    >
      {isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : !view ? (
        <Stack align="center" p="xl">
          <Text c="dimmed">This box isn&apos;t available right now.</Text>
          <Button variant="default" onClick={dialog.onClose}>
            Close
          </Button>
        </Stack>
      ) : (
        <>
          <Grid classNames={{ inner: 'my-0' }}>
            <Grid.Col span={{ base: 12, md: 5 }} p="lg">
              <BoxSummary view={view} tiers={tiers} color={color} onClose={dialog.onClose}>
                <div className="hidden md:block">{actions}</div>
              </BoxSummary>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 7 }} p="lg" className="bg-gray-0 dark:bg-dark-8">
              <BoxContents view={view} tiers={tiers} color={color} />
            </Grid.Col>
          </Grid>
          {/* On a phone the contents scroll under the button, as a bottom sheet's would. */}
          <div className="sticky bottom-0 z-[5] border-0 border-t border-solid border-gray-3 bg-white p-3 md:hidden dark:border-dark-4 dark:bg-dark-7">
            {actions}
          </div>
          {opener.phase !== 'idle' && (
            <OpenStage
              view={view}
              color={color}
              phase={opener.phase}
              result={opener.result}
              shelfPrices={shelfPrices}
              busy={opener.busy}
              onPlace={event ? placeReward : undefined}
              onAgain={() => opener.buyAndOpen(view)}
              onDone={opener.reset}
            />
          )}
        </>
      )}
    </Modal>
  );
}

function BoxSummary({
  view,
  tiers,
  color,
  onClose,
  children,
}: {
  view: MysteryBoxView;
  tiers: TierSummary[];
  color: string;
  onClose: () => void;
  /** The buy and open buttons, where the layout puts them. */
  children: ReactNode;
}) {
  return (
    <Stack gap="md" className="md:sticky md:top-0">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <MysteryBoxArt art={view.art} color={color} size={120} />
        <CloseButton onClick={onClose} aria-label="Close" />
      </Group>
      <div>
        <Text fw={700} size="lg">
          {view.name}
        </Text>
        {view.team && (
          <Text size="sm" c="dimmed">
            Team {view.team} only
          </Text>
        )}
      </div>
      <Text size="sm">
        You get <b>1 hat you don&apos;t own yet</b>. The rarity is rolled first, then every hat you
        don&apos;t own in that rarity is equally likely.
      </Text>
      <MysteryBoxOddsBar tiers={tiers} legend={false} />
      <Stack gap={4} data-testid="box-tier-odds">
        {tiers.map((t) => (
          <Group key={t.tier.id} justify="space-between" wrap="nowrap">
            <Group gap={6} wrap="nowrap">
              <span
                className="inline-block size-2 rounded-full"
                style={{ background: tierColor(t.tier) }}
              />
              <Text size="sm">{t.tier.name}</Text>
            </Group>
            <Text size="sm">
              <b>{formatChance(t.probability, 1)}</b>{' '}
              <Text component="span" size="sm" c="dimmed">
                · {t.left ? `${formatChance(t.itemProbability)} each` : 'complete'}
              </Text>
            </Text>
          </Group>
        ))}
      </Stack>
      <Text size="xs" c="dimmed">
        Your odds change as you collect: once you own every hat in a rarity, it drops out and the
        others share its chance.{' '}
        <Anchor href={mysteryBoxOddsPageUrl(view)} target="_blank" inherit>
          Full odds &amp; history
        </Anchor>
      </Text>
      {children}
    </Stack>
  );
}

function BoxActions({
  view,
  buzzType,
  busy,
  onBuy,
  onOpen,
}: {
  view: MysteryBoxView;
  buzzType: ReturnType<typeof useAvailableBuzz>[number];
  busy: boolean;
  onBuy: () => void;
  onOpen: () => void;
}) {
  const { left, total } = collectedCount(view);
  const actions = boxActions(view);
  const held = view.heldBoxItemIds.length;

  return (
    <Stack gap={6}>
      {actions.complete ? (
        <Badge size="lg" color="yellow" variant="light" fullWidth>
          Complete · {total} / {total}
        </Badge>
      ) : (
        <>
          {actions.canOpen && (
            <Button radius="xl" onClick={onOpen} loading={busy} data-testid="box-open-held">
              Open your box{held > 1 ? ` (${held})` : ''}
            </Button>
          )}
          {actions.canBuy && view.listing && (
            <BuzzTransactionButton
              radius="xl"
              buzzAmount={view.listing.unitAmount}
              accountTypes={[buzzType]}
              label="Buy and open"
              loading={busy}
              onPerformTransaction={onBuy}
              data-testid="box-buy-open"
            />
          )}
          {actions.covered && (
            <Text size="xs" c="dimmed" ta="center">
              Your unopened {held === 1 ? 'box covers' : 'boxes cover'} everything left. Open{' '}
              {held === 1 ? 'it' : 'them'} first.
            </Text>
          )}
        </>
      )}
      <Text size="xs" c="dimmed" ta="center">
        {left} {left === 1 ? 'hat' : 'hats'} left for you
        {view.listing ? ' · paid Buzz only' : ''}
      </Text>
    </Stack>
  );
}

function BoxContents({
  view,
  tiers,
  color,
}: {
  view: MysteryBoxView;
  tiers: TierSummary[];
  color: string;
}) {
  return (
    <Stack gap="lg">
      <Text fw={700}>What&apos;s inside ({view.contents.length})</Text>
      {tiers.map((t) => (
        <Stack key={t.tier.id} gap="xs" data-testid="box-tier">
          <Group gap="xs">
            <Badge
              variant="light"
              style={{ color: tierColor(t.tier), background: `${tierColor(t.tier)}22` }}
            >
              {t.tier.name}
            </Badge>
            <Text size="sm" fw={700}>
              {formatChance(t.probability, 1)}
            </Text>
            <Text size="xs" c="dimmed">
              {t.left ? `${formatChance(t.itemProbability)} each · ` : ''}
              {t.left} left of {t.contents.length}
            </Text>
          </Group>
          <SimpleGrid cols={{ base: 4, sm: 6 }} spacing={6}>
            {t.contents.map((c) => (
              <div
                key={c.contentId}
                className="relative"
                title={c.name ?? undefined}
                data-owned={!c.left}
              >
                {c.url && (
                  <HatArt
                    url={c.url}
                    fit={c.fit as EventDecorationFit | undefined}
                    width={96}
                    color={c.left ? color : undefined}
                    className={clsx(!c.left && 'opacity-35 grayscale')}
                  />
                )}
                {!c.left && (
                  <span className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-green-7 text-white">
                    <IconCheck size={11} stroke={3} />
                  </span>
                )}
              </div>
            ))}
          </SimpleGrid>
        </Stack>
      ))}
    </Stack>
  );
}

function OpenStage({
  view,
  color,
  phase,
  result,
  shelfPrices,
  busy,
  onPlace,
  onAgain,
  onDone,
}: {
  view: MysteryBoxView;
  color: string;
  phase: OpenPhase;
  result: ReturnType<typeof useMysteryBoxOpen>['result'];
  shelfPrices: Record<number, number>;
  busy: boolean;
  /** Absent for a reward with no event: only event hats are placed on posts. */
  onPlace?: () => void;
  onAgain: () => void;
  onDone: () => void;
}) {
  const tier = result ? view.tiers.find((t) => t.id === result.tierId) : undefined;
  const reward = result ? view.contents.find((c) => c.contentId === result.contentId) : undefined;
  const glow = tier ? tierColor(tier) : color;
  const { collected, total } = collectedCount(view);
  const shelfPrice = reward ? shelfPrices[reward.cosmeticId] : undefined;
  const actions = boxActions(view);
  const revealed = phase === 'revealed';

  return (
    <div
      className="absolute inset-0 z-10 rounded-[inherit]"
      style={{ background: 'radial-gradient(circle at 50% 45%, #2a1220, #0e0e10 70%)' }}
      data-testid="box-stage"
      data-phase={phase}
      aria-live="polite"
    >
      <div
        className={clsx(styles.stageView, 'flex flex-col items-center justify-center gap-4 p-6')}
        data-testid="box-stage-view"
      >
        <div
          className={styles.glow}
          style={{ '--glow': glow } as CSSProperties}
          data-on={phase === 'glowing' || phase === 'lidOff' || revealed}
        />
        {!revealed && (
          <>
            <MysteryBoxArt
              art={view.art}
              color={color}
              size={160}
              shaking={phase === 'shaking' || phase === 'glowing'}
              lidOff={phase === 'lidOff'}
              open={phase === 'lidOff'}
            />
            <Text c="white" fw={600} mih={22}>
              {PHASE_MESSAGE[phase] ?? ''}
            </Text>
          </>
        )}
        {revealed && result && (
          <Stack align="center" gap="sm" className={clsx('relative', styles.reveal)}>
            {tier && (
              <Badge
                size="lg"
                variant="filled"
                style={{ background: `${tierColor(tier)}33`, color: tierColor(tier) }}
              >
                {tier.name} · {formatChance(revealChance(result.odds))} chance
              </Badge>
            )}
            <div className="w-44">
              {reward?.url && (
                <HatArt
                  url={reward.url}
                  fit={reward.fit as EventDecorationFit | undefined}
                  color={glow}
                  width={256}
                  className="!bg-transparent"
                />
              )}
            </div>
            <Text c="white" fw={800} size="xl" ta="center">
              {reward?.name ?? 'A new hat'}
            </Text>
            <Text size="sm" c="dimmed">
              {shelfPrice
                ? `Also on the shelf at ${numberWithCommas(shelfPrice)} Buzz`
                : 'Only in the Mystery Box'}
            </Text>
            <Group gap="xs" justify="center">
              {onPlace && (
                <Button onClick={onPlace} data-testid="box-place">
                  Put it on a post
                </Button>
              )}
              {actions.canBuy && view.listing && (
                <Button color="yellow" onClick={onAgain} loading={busy} data-testid="box-again">
                  Open another · {numberWithCommas(view.listing.unitAmount)}
                </Button>
              )}
              <Button variant="default" onClick={onDone}>
                Done
              </Button>
            </Group>
            <Text size="sm" c="white">
              <b>{collected}</b> / {total} {view.team ? `Team ${view.team} ` : ''}hats collected
            </Text>
          </Stack>
        )}
        {revealed && result && <Confetti color={glow} />}
      </div>
    </div>
  );
}

const CONFETTI = Array.from({ length: 36 }, (_, i) => {
  const angle = (i / 36) * Math.PI * 2;
  const reach = 120 + ((i * 53) % 160);
  return { x: Math.cos(angle) * reach, y: Math.sin(angle) * reach, delay: ((i * 7) % 15) / 100 };
});

function Confetti({ color }: { color: string }) {
  const colors = [color, '#f06595', '#ffd43b', '#ffffff'];
  return (
    <div className={styles.burst} aria-hidden>
      {CONFETTI.map((p, i) => (
        <i
          key={i}
          style={
            {
              '--x': `${p.x}px`,
              '--y': `${p.y}px`,
              background: colors[i % colors.length],
              animationDelay: `${p.delay}s`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
