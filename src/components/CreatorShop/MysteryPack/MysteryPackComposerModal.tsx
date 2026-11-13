import {
  Alert,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  NativeSelect,
  NumberInput,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import {
  CREATOR_BOX_MAX_CONTENTS,
  CREATOR_BOX_MAX_TIERS,
  CREATOR_BOX_MIN_CONTENTS,
  CREATOR_BOX_MIN_TIERS,
  CREATOR_BOX_STEEPNESS,
  CREATOR_BOX_TIERS,
  type CreatorBoxSteepness,
} from '@civitai/shared/creator-box-rules';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { submissionIntent, withPaymentIntentKey } from '~/components/Buzz/payment-intent-keys';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';
import { CosmeticThumb } from '~/components/CreatorShop/CosmeticThumb';
import { useMutateCreatorShop } from '~/components/CreatorShop/creator-shop.util';
import { previewMysteryPack } from '~/components/CreatorShop/MysteryPack/mystery-pack-draft';
import { FeeSection } from '~/components/CreatorShop/Submit/FeeSection';
import {
  FEE_UNAVAILABLE_MESSAGE,
  useCreatorShopFees,
} from '~/components/CreatorShop/useCreatorShopFees';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { MysteryBoxOddsBar } from '~/components/MysteryBox/MysteryBoxOddsBar';
import { formatChance, tierColor } from '~/components/MysteryBox/mystery-box.utils';
import { useIsMobile } from '~/hooks/useIsMobile';
import type { MyMysteryPack } from '~/server/services/creator-mystery-pack-read.service';
import { showErrorNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const STEEPNESS_LABELS: Record<CreatorBoxSteepness, { label: string; hint: string }> = {
  gentle: { label: 'Gentle', hint: 'Each rarer item is 0.6 times as likely as the tier below.' },
  standard: {
    label: 'Standard',
    hint: 'Each rarer item is 0.4 times as likely as the tier below.',
  },
  steep: { label: 'Steep', hint: 'Each rarer item is 0.2 times as likely as the tier below.' },
};
const NOT_IN_PACK = '-1';

export function MysteryPackComposerModal({ pack }: { pack?: MyMysteryPack }) {
  const dialog = useDialogContext();
  const isMobile = useIsMobile({ type: 'media' });
  const isEdit = !!pack;
  const { submitMysteryPack, reviseMysteryPack } = useMutateCreatorShop();
  const { data: candidates, isLoading } = trpc.creatorShop.getMysteryPackCandidates.useQuery();

  const proposal = pack?.proposal;
  const [name, setName] = useState(pack?.name ?? '');
  const [description, setDescription] = useState(pack?.description ?? '');
  const [steepness, setSteepness] = useState<CreatorBoxSteepness>(
    proposal?.steepness ?? 'standard'
  );
  const [tierCount, setTierCount] = useState(proposal?.tiers.length ?? 3);
  const [assignment, setAssignment] = useState<Record<number, number>>(() =>
    Object.fromEntries(
      (proposal?.tiers ?? []).flatMap((tier, t) => tier.cosmeticIds.map((id) => [id, t]))
    )
  );
  const [price, setPrice] = useState<number | undefined>(proposal?.price);
  const [search, setSearch] = useState('');
  const [onlyChosen, setOnlyChosen] = useState(false);
  const [buzzType, setBuzzType] = useState<'yellow' | 'green' | 'blue'>('yellow');

  const tierNames = CREATOR_BOX_TIERS[tierCount];
  const draft = useMemo(() => {
    const tiers: number[][] = Array.from({ length: tierCount }, () => []);
    for (const [id, t] of Object.entries(assignment)) if (t < tierCount) tiers[t].push(Number(id));
    return { steepness, tiers };
  }, [assignment, tierCount, steepness]);
  const chosen = draft.tiers.flat();

  const values = useMemo(
    () =>
      new Map(
        (candidates ?? []).flatMap((c) => (c.value === null ? [] : [[c.cosmeticId, c.value]]))
      ),
    [candidates]
  );
  const chosenWithProblem = (candidates ?? []).filter(
    (c) => c.problem && assignment[c.cosmeticId] !== undefined
  );
  const preview = previewMysteryPack(draft, values, price);
  const emptyTier = draft.tiers.findIndex((tier) => !tier.length);

  const packFee = useCreatorShopFees()?.mysteryPack;
  const { data: buzz, isLoading: loadingBuzz } = useQueryBuzz(['yellow', 'green', 'blue']);
  const balance = (type: string) => buzz.accounts.find((a) => a.type === type)?.balance ?? 0;
  const feeShortfall =
    !isEdit && !loadingBuzz && packFee !== undefined && balance(buzzType) < packFee;

  const problems = [
    !chosen.length
      ? `Pick ${CREATOR_BOX_MIN_CONTENTS} to ${CREATOR_BOX_MAX_CONTENTS} of your items`
      : chosen.length < CREATOR_BOX_MIN_CONTENTS
      ? `Add ${
          CREATOR_BOX_MIN_CONTENTS - chosen.length
        } more (at least ${CREATOR_BOX_MIN_CONTENTS})`
      : null,
    chosen.length > CREATOR_BOX_MAX_CONTENTS
      ? `Remove ${chosen.length - CREATOR_BOX_MAX_CONTENTS} (at most ${CREATOR_BOX_MAX_CONTENTS})`
      : null,
    emptyTier >= 0 && chosen.length
      ? `${tierNames[emptyTier].name} has no items: add one or remove the tier`
      : null,
    ...chosenWithProblem.map((c) => `${c.name}: ${c.problem}`),
    emptyTier < 0 && !chosenWithProblem.length ? preview.layoutProblem : null,
  ].filter((p): p is string => !!p);

  const canSubmit =
    !problems.length && preview.ready && (isEdit || (!!name.trim() && packFee !== undefined));

  const shown = (candidates ?? []).filter(
    (c) =>
      (!onlyChosen || assignment[c.cosmeticId] !== undefined) &&
      (!search.trim() || c.name.toLowerCase().includes(search.trim().toLowerCase()))
  );

  const setTier = (cosmeticId: number, tier: number) =>
    setAssignment((current) => {
      const { [cosmeticId]: _removed, ...rest } = current;
      return tier < 0 ? rest : { ...rest, [cosmeticId]: tier };
    });
  const changeTierCount = (next: number) => {
    setTierCount(next);
    // Drop items in removed tiers; don't clamp them into another tier.
    setAssignment((current) =>
      Object.fromEntries(Object.entries(current).filter(([, t]) => t < next))
    );
  };

  const submit = async () => {
    if (!canSubmit || price === undefined) return;
    if (isEdit) {
      await reviseMysteryPack.mutateAsync({
        boxId: pack.boxId,
        steepness,
        tiers: draft.tiers,
        price,
      });
    } else {
      if (packFee === undefined) {
        showErrorNotification({ title: 'Not ready', error: new Error(FEE_UNAVAILABLE_MESSAGE) });
        return;
      }
      const submission = {
        name: name.trim(),
        description: description.trim() || null,
        steepness,
        tiers: draft.tiers,
        price,
        buzzType,
        quotedFee: packFee,
      };
      await withPaymentIntentKey(
        submissionIntent('creator-mystery-pack', submission),
        (idempotencyKey) => submitMysteryPack.mutateAsync({ ...submission, idempotencyKey })
      );
    }
    dialog.onClose();
  };

  return (
    <Modal
      {...dialog}
      size="xl"
      fullScreen={isMobile}
      title={isEdit ? `Edit ${pack.name}` : 'Build a mystery pack'}
      radius="lg"
    >
      <Stack gap="md">
        {isEdit && (
          <Text size="xs" c="dimmed">
            Your live version keeps selling while this edit is reviewed.
          </Text>
        )}
        {!isEdit && (
          <>
            <TextInput
              label="Name"
              value={name}
              maxLength={255}
              onChange={(e) => setName(e.currentTarget.value)}
              data-testid="mp-name"
            />
            <Textarea
              label="Description"
              value={description}
              maxLength={1000}
              autosize
              minRows={2}
              onChange={(e) => setDescription(e.currentTarget.value)}
            />
          </>
        )}

        <Stack gap={4}>
          <Text fw={600} size="sm">
            Steepness
          </Text>
          <SegmentedControl
            fullWidth
            value={steepness}
            onChange={(v) => setSteepness(v as CreatorBoxSteepness)}
            data={(Object.keys(CREATOR_BOX_STEEPNESS) as CreatorBoxSteepness[]).map((key) => ({
              value: key,
              label: STEEPNESS_LABELS[key].label,
            }))}
            data-testid="mp-steepness"
          />
          <Text size="xs" c="dimmed">
            {STEEPNESS_LABELS[steepness].hint}
          </Text>
        </Stack>

        <Group justify="space-between" align="center">
          <Text fw={600} size="sm">
            Tiers ({tierCount}): {tierNames.map((t) => t.name).join(', ')}
          </Text>
          <Group gap="xs">
            <Button
              size="compact-sm"
              variant="default"
              disabled={tierCount <= CREATOR_BOX_MIN_TIERS}
              onClick={() => changeTierCount(tierCount - 1)}
              data-testid="mp-tier-less"
            >
              − tier
            </Button>
            <Button
              size="compact-sm"
              variant="default"
              disabled={tierCount >= CREATOR_BOX_MAX_TIERS}
              onClick={() => changeTierCount(tierCount + 1)}
              data-testid="mp-tier-more"
            >
              + tier
            </Button>
          </Group>
        </Group>

        <Stack gap="xs">
          <Group justify="space-between" align="center">
            <Text fw={600} size="sm">
              Your items
            </Text>
            <Text size="sm" data-testid="mp-count">
              {chosen.length} of {CREATOR_BOX_MAX_CONTENTS} chosen
            </Text>
          </Group>
          <Group gap="xs" wrap="nowrap">
            <TextInput
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              className="flex-1"
              aria-label="Search your items"
            />
            <SegmentedControl
              size="xs"
              value={onlyChosen ? 'chosen' : 'all'}
              onChange={(v) => setOnlyChosen(v === 'chosen')}
              data={[
                { value: 'all', label: 'All' },
                { value: 'chosen', label: 'In pack' },
              ]}
            />
          </Group>
          {isLoading ? (
            <Center py="md">
              <Loader />
            </Center>
          ) : !shown.length ? (
            <Text size="sm" c="dimmed" data-testid="mp-no-items">
              {candidates?.length
                ? 'No items match.'
                : "You haven't made any items yet. Items need to be live in your shop first."}
            </Text>
          ) : (
            <Stack gap={6} mah={isMobile ? undefined : 360} className="overflow-y-auto">
              {shown.map((c) => {
                const tier = assignment[c.cosmeticId];
                const inPack = tier !== undefined;
                return (
                  <Paper
                    key={c.cosmeticId}
                    withBorder
                    radius="md"
                    p="xs"
                    data-testid="mp-item"
                    data-ineligible={c.problem ? 'true' : undefined}
                    style={{ opacity: c.problem && !inPack ? 0.55 : 1 }}
                  >
                    <Group gap="xs" wrap="nowrap" align="center">
                      <CosmeticThumb data={c.data} name={c.name} />
                      <Stack gap={0} className="min-w-0 flex-1">
                        <Text size="sm" fw={600} lineClamp={1}>
                          {c.name}
                        </Text>
                        {c.problem ? (
                          <Text size="xs" c="red" lineClamp={2}>
                            {c.problem}
                          </Text>
                        ) : (
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            {getDisplayName(c.type)} · {numberWithCommas(c.value ?? 0)} Buzz
                          </Text>
                        )}
                      </Stack>
                      <NativeSelect
                        aria-label={`Tier for ${c.name}`}
                        size="xs"
                        w={108}
                        value={String(tier ?? NOT_IN_PACK)}
                        disabled={!!c.problem && !inPack}
                        onChange={(e) => setTier(c.cosmeticId, Number(e.currentTarget.value))}
                        data={[
                          { value: NOT_IN_PACK, label: 'Not in pack' },
                          ...tierNames.map((t, i) => ({ value: String(i), label: t.name })),
                        ]}
                      />
                    </Group>
                  </Paper>
                );
              })}
            </Stack>
          )}
        </Stack>

        <Stack gap={6} data-testid="mp-odds">
          <Text fw={600} size="sm">
            Odds
          </Text>
          {preview.odds.length ? (
            <>
              <MysteryBoxOddsBar tiers={preview.odds} legend={false} />
              {preview.odds.map((t) => (
                <Group key={t.tier.id} justify="space-between" wrap="nowrap">
                  <Group gap={6} wrap="nowrap">
                    <span
                      className="inline-block size-2 rounded-full"
                      style={{ background: tierColor(t.tier) }}
                    />
                    <Text size="sm">
                      {t.tier.name} · {t.contents.length}{' '}
                      {t.contents.length === 1 ? 'item' : 'items'}
                    </Text>
                  </Group>
                  <Text size="sm">
                    <b>{formatChance(t.probability, 1)}</b>{' '}
                    <Text component="span" size="sm" c="dimmed">
                      · {formatChance(t.itemProbability)} each
                    </Text>
                  </Text>
                </Group>
              ))}
            </>
          ) : (
            <Text size="sm" c="dimmed">
              Odds show once the tiers are valid.
            </Text>
          )}
        </Stack>

        {!!problems.length && (
          <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />}>
            <Stack gap={2} data-testid="mp-problems">
              {problems.map((p) => (
                <Text key={p} size="sm">
                  {p}
                </Text>
              ))}
            </Stack>
          </Alert>
        )}

        <Stack gap={4}>
          <NumberInput
            label="Price (Buzz)"
            value={price ?? ''}
            min={0}
            allowDecimal={false}
            allowNegative={false}
            thousandSeparator=","
            onChange={(v) => setPrice(typeof v === 'number' ? v : undefined)}
            error={!problems.length && price !== undefined ? preview.priceProblem : undefined}
            data-testid="mp-price"
          />
          {preview.bounds ? (
            <Text size="xs" c="dimmed" data-testid="mp-bounds">
              {preview.bounds.max < preview.bounds.min
                ? 'No price works for these items.'
                : `Allowed: ${numberWithCommas(preview.bounds.min)} to ${numberWithCommas(
                    preview.bounds.max
                  )} Buzz`}{' '}
              · the average pack gives back {numberWithCommas(preview.bounds.average)} · your
              cheapest item is {numberWithCommas(preview.bounds.worst)}
            </Text>
          ) : (
            <Text size="xs" c="dimmed">
              The price range shows once your tiers are valid.
            </Text>
          )}
        </Stack>

        {!isEdit && (
          <FeeSection
            buzzType={buzzType}
            onBuzzTypeChange={setBuzzType}
            yellowBalance={balance('yellow')}
            greenBalance={balance('green')}
            blueBalance={balance('blue')}
            feeAccountBalance={balance(buzzType)}
            canAffordFee={!feeShortfall}
            submissionFee={packFee}
          />
        )}
        <Text size="xs" c="dimmed">
          A moderator reviews every pack before it goes on sale. Prices can be lowered later without
          review; raising one is an edit.
        </Text>

        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          {isEdit ? (
            <Button
              disabled={!canSubmit}
              loading={reviseMysteryPack.isPending}
              onClick={submit}
              data-testid="mp-submit"
            >
              Submit edit for review
            </Button>
          ) : (
            <BuzzTransactionButton
              disabled={!canSubmit}
              loading={submitMysteryPack.isPending}
              buzzAmount={packFee ?? 0}
              priceReplacement={packFee === undefined ? '…' : undefined}
              exactAccountTypes={[buzzType]}
              colorType={buzzType}
              label="Submit for review"
              onPerformTransaction={submit}
              data-testid="mp-submit"
            />
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
