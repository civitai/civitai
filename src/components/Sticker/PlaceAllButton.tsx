import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { placeAllPlan, runPlaceAll } from '~/components/Sticker/place-all';
import { useStickerPlacementDraftStore as useStore } from '~/store/sticker-placement-draft.store';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Places every draft that is ready, for one confirmation of the summed price.
 *
 * Not a new purchase: it presses each draft's own placement in turn, so free placement, owned uses
 * and the server's refusals are exactly what each draft's button would get.
 */
export function PlaceAllButton(props: { price: number; className?: string }) {
  const drafts = useStore((state) => state.drafts);
  const ready = useStore((state) => state.readyPlacements);
  const running = useStore((state) => state.placingAll);
  const plan = placeAllPlan({ drafts, ready, price: props.price });
  // Kept while running: placing shrinks the queue, and unmounting mid-run would drop the spinner.
  // No price set: every paid placement would be refused, so the batch could not work.
  if (!running && (plan.queue.length < 2 || (plan.paid > 0 && props.price <= 0))) return null;
  return <PlaceAllControl {...props} plan={plan} running={running} />;
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
    // meanwhile must not be placed. Taken once, so later re-renders cannot change the run.
    const now = useStore.getState();
    const fresh = placeAllPlan({ drafts: now.drafts, ready: now.readyPlacements, price });
    if (fresh.total > plan.total || fresh.queue.length < 2)
      return showErrorNotification({
        title: 'Your stickers changed',
        error: new Error('Nothing was placed. Check them and press Place all again.'),
      });
    const items = fresh.queue.map((draftId) => ({
      draftId,
      input: now.readyPlacements[draftId].input(),
    }));
    setRunning(true);
    try {
      const result = await runPlaceAll(items, (input) => create.mutateAsync(input), cancelDraft);
      if (result.failed)
        showErrorNotification({
          title: `Placed ${result.placed} of ${items.length}`,
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
