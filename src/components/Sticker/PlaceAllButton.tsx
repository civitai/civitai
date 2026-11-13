import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { placeAllPlan, runPlaceAll } from '~/components/Sticker/place-all';
import { useStickerPlacementDraftStore as useStore } from '~/store/sticker-placement-draft.store';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Places every ready draft for one confirmation of the summed price. Each is sent with the input
 * its own Place button would send, so free placement, owned uses and the server's refusals match.
 * `price` is null while the creator has set none; a price of 0 is a real price.
 */
export function PlaceAllButton(props: { price: number | null; className?: string }) {
  const drafts = useStore((state) => state.drafts);
  const ready = useStore((state) => state.readyPlacements);
  const running = useStore((state) => state.placingAll);
  const plan = placeAllPlan({ drafts, ready, price: props.price ?? 0 });
  // Kept while running: placing shrinks the queue, and unmounting mid-run would drop the spinner.
  if (!running && (plan.queue.length < 2 || (plan.paid > 0 && props.price == null))) return null;
  return (
    <PlaceAllControl
      className={props.className}
      price={props.price ?? 0}
      plan={plan}
      running={running}
    />
  );
}

function PlaceAllControl({
  price,
  className,
  plan,
  running,
}: {
  price: number;
  className?: string;
  plan: ReturnType<typeof placeAllPlan>;
  running: boolean;
}) {
  const cancelDraft = useStore((state) => state.cancelDraft);
  const setRunning = useStore((state) => state.setPlacingAll);
  const spendTypes = useAvailableBuzz();
  const utils = trpc.useUtils();
  const create = trpc.placement.createSticker.useMutation();

  const placeAll = async () => {
    // Read fresh: a Buzz purchase can sit between the press and this call, and a draft removed
    // meanwhile must not be placed.
    const now = useStore.getState();
    const items = placeAllPlan({ drafts: now.drafts, ready: now.readyPlacements, price }).queue.map(
      (draftId) => ({ draftId, input: now.readyPlacements[draftId].input() })
    );
    // Priced from what will be sent, so the check covers the same placements that will be charged,
    // at the price the tray last loaded. The server charges the space's current price on each call.
    const charged = items.filter((item) => !item.input.free).length * price;
    if (charged > plan.total || items.length < 2)
      return showErrorNotification({
        title: 'Your stickers changed',
        error: new Error('Nothing was placed. Check them and press Place all again.'),
      });
    setRunning(true);
    try {
      const result = await runPlaceAll(
        items,
        (input) => create.mutateAsync(input),
        cancelDraft,
        (draftId) => useStore.getState().drafts.some((draft) => draft.id === draftId)
      );
      if (result.failed)
        showErrorNotification({
          title: `Placed ${result.placed} of ${items.length - result.skipped}`,
          error: new Error(
            `${result.failed.error.message} The rest are still here to place one at a time.`
          ),
        });
      else
        showSuccessNotification({
          title: `${result.placed} stickers placed`,
          message: result.pending
            ? 'Only you can see the ones waiting until the creator approves them.'
            : 'They are live on the image now.',
        });
    } finally {
      // Uses, the free allowance and the image's placements all moved.
      await Promise.all([
        utils.placement.invalidate(),
        utils.cosmetic.getStickerBalances.invalidate(),
      ]).catch(() => null);
      setRunning(false);
    }
  };

  const label = `Place all ${plan.queue.length}`;
  return (
    <BuzzTransactionButton
      size="xs"
      className={className}
      buzzAmount={plan.total}
      accountTypes={spendTypes}
      label={label}
      loading={running}
      data-place-all=""
      onPerformTransaction={() => void placeAll()}
    />
  );
}
