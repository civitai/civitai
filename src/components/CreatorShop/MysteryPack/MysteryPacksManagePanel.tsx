import {
  Alert,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  NumberInput,
  Paper,
  Stack,
  Text,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconPlus } from '@tabler/icons-react';
import { useState } from 'react';
import { useMutateCreatorShop } from '~/components/CreatorShop/creator-shop.util';
import { MysteryPackComposerModal } from '~/components/CreatorShop/MysteryPack/MysteryPackComposerModal';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { NextLink } from '~/components/NextLink/NextLink';
import { mysteryBoxOddsPageUrl } from '~/components/MysteryBox/mystery-box.utils';
import type { MyMysteryPack } from '~/server/services/creator-mystery-pack-read.service';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

export function mysteryPackStatus(pack: MyMysteryPack): { label: string; color: string } {
  if (pack.boxStatus === 'archived') return { label: 'Archived', color: 'gray' };
  switch (pack.listing?.status) {
    case 'Published':
      return pack.pending
        ? { label: 'Live · edit in review', color: 'blue' }
        : { label: 'Live', color: 'green' };
    case 'PendingReview':
      return { label: 'In review', color: 'yellow' };
    case 'RequestedChanges':
      return { label: 'Changes requested', color: 'orange' };
    case 'Rejected':
      return { label: 'Rejected', color: 'red' };
    default:
      return { label: 'Draft', color: 'gray' };
  }
}

/** Only a live pack with no edit waiting, or one sent back, can be edited: the server refuses the rest. */
const canEdit = (pack: MyMysteryPack) =>
  !pack.pending &&
  pack.boxStatus !== 'archived' &&
  (pack.listing?.status === 'Published' || pack.listing?.status === 'RequestedChanges');

export function MysteryPacksManagePanel({
  canBuild,
  userId,
}: {
  /** The creator themselves; a moderator looking at another creator's packs can't build for them. */
  canBuild: boolean;
  userId?: number;
}) {
  const {
    data: packs,
    isLoading,
    isError,
  } = trpc.creatorShop.getMyMysteryPacks.useQuery({ userId });
  const { withdrawMysteryPackRevision } = useMutateCreatorShop();
  const withdraw = (pack: MyMysteryPack) =>
    openConfirmModal({
      title: pack.listing?.status === 'Published' ? 'Withdraw this edit?' : 'Withdraw this pack?',
      children: (
        <Text size="sm">
          {pack.listing?.status === 'Published'
            ? 'The live version keeps selling.'
            : 'It has not been approved yet, so withdrawing archives it. The submission fee is not refunded.'}
        </Text>
      ),
      labels: { confirm: 'Withdraw', cancel: 'Keep' },
      confirmProps: { color: 'red' },
      onConfirm: () => withdrawMysteryPackRevision.mutate({ boxId: pack.boxId }),
    });

  return (
    <Stack gap="md">
      <Group justify="space-between" align="center">
        <Text size="sm" c="dimmed" maw={560}>
          Mystery packs hold 6 to 50 of your own items in tiers. Buyers get one item they don&apos;t
          own yet, rarer tiers less often.
        </Text>
        {canBuild && (
          <Button
            leftSection={<IconPlus size={16} />}
            onClick={() => dialogStore.trigger({ component: MysteryPackComposerModal })}
            data-testid="mp-build"
          >
            Build a mystery pack
          </Button>
        )}
      </Group>
      {isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : isError ? (
        <Alert color="red">Couldn&apos;t load your mystery packs.</Alert>
      ) : !packs?.length ? (
        <Text size="sm" c="dimmed" data-testid="mp-empty">
          No mystery packs yet.
        </Text>
      ) : (
        packs.map((pack) => {
          const status = mysteryPackStatus(pack);
          const live = pack.listing?.status === 'Published' && pack.boxStatus === 'published';
          return (
            <Paper key={pack.boxId} withBorder radius="md" p="md" data-testid="mp-pack">
              <Stack gap="xs">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Stack gap={2} className="min-w-0">
                    <Text fw={700} lineClamp={1}>
                      {pack.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {pack.listing ? `${numberWithCommas(pack.listing.unitAmount)} Buzz` : ''}
                      {pack.proposal
                        ? ` · ${pack.proposal.tiers.flatMap((t) => t.cosmeticIds).length} items`
                        : ''}
                    </Text>
                  </Stack>
                  <Badge color={status.color} variant="light" className="shrink-0">
                    {status.label}
                  </Badge>
                </Group>
                {pack.rejection && (
                  <Alert color="orange" variant="light" data-testid="mp-note">
                    Reviewer&apos;s note: {pack.rejection}
                  </Alert>
                )}
                {canBuild && (
                  <Group gap="xs">
                    {canEdit(pack) && (
                      <Button
                        size="compact-md"
                        variant="light"
                        onClick={() =>
                          dialogStore.trigger({
                            component: MysteryPackComposerModal,
                            props: { pack },
                          })
                        }
                      >
                        Edit
                      </Button>
                    )}
                    {pack.pending && (
                      <Button
                        size="compact-md"
                        variant="default"
                        loading={withdrawMysteryPackRevision.isPending}
                        onClick={() => withdraw(pack)}
                      >
                        {live ? 'Withdraw edit' : 'Withdraw submission'}
                      </Button>
                    )}
                    {live && !pack.pending && pack.listing && (
                      <LowerPrice boxId={pack.boxId} current={pack.listing.unitAmount} />
                    )}
                    {live && (
                      <Button
                        size="compact-md"
                        variant="subtle"
                        component={NextLink}
                        href={mysteryBoxOddsPageUrl({
                          boxDefinitionId: pack.boxId,
                          team: undefined,
                        })}
                      >
                        Contents &amp; odds
                      </Button>
                    )}
                  </Group>
                )}
              </Stack>
            </Paper>
          );
        })
      )}
    </Stack>
  );
}

function LowerPrice({ boxId, current }: { boxId: number; current: number }) {
  const { lowerMysteryPackPrice } = useMutateCreatorShop();
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState<number | undefined>(current);
  if (!open)
    return (
      <Button size="compact-md" variant="default" onClick={() => setOpen(true)}>
        Lower price
      </Button>
    );
  return (
    <Group gap="xs" align="flex-end">
      <NumberInput
        aria-label="New price"
        size="xs"
        w={110}
        min={1}
        max={current - 1}
        allowDecimal={false}
        value={price ?? ''}
        onChange={(v) => setPrice(typeof v === 'number' ? v : undefined)}
      />
      <Button
        size="compact-md"
        loading={lowerMysteryPackPrice.isPending}
        disabled={price === undefined || price >= current}
        onClick={() =>
          price !== undefined &&
          lowerMysteryPackPrice.mutate({ boxId, price }, { onSuccess: () => setOpen(false) })
        }
      >
        Save
      </Button>
    </Group>
  );
}
