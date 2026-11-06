import { ActionIcon, Button, Loader, Modal, Text, TextInput, UnstyledButton } from '@mantine/core';
import { Menu } from '~/components/MantineOverlays';
import { IconDots, IconX } from '@tabler/icons-react';
import { getQueryKey } from '@trpc/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { RemixResultLine } from '~/components/Image/Remix/RemixResultLine';
import { isRunningWorkflow, useRemixRuns } from '~/components/Image/Remix/useRemixRuns';
import { setCachedWorkflowTag } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { remixResultGalleryOffer } from '~/components/RemixGallery/remix-gallery.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { RemixRunState } from '~/server/services/remix-app-run.service';
import { TEAM_REMIX_SLUG } from '~/shared/constants/remix-apps.constants';
import type { RemixAnswer, RemixImage, RemixViewerAsk } from '~/shared/remix-apps/define';
import { REMIX_DONE_TAG } from '~/shared/remix-apps/tags';
import { generationGraphPanel } from '~/store/generation-graph.store';
import {
  showErrorNotification,
  showSuccessNotification,
  showWarningNotification,
} from '~/utils/notifications';
import { queryClient, trpc } from '~/utils/trpc';

export type RemixModalApp = { slug: string; name: string; runtime: boolean };

export type RemixAppModalProps = {
  app: RemixModalApp;
  /** The image it remixes. Absent for a run reopened from the tray whose source is unknown. */
  imageId?: number;
  /** Reopening a run from the tray: the modal follows it instead of offering a new one. */
  run?: { runId?: string; workflowId: string };
  /** Shown under a started run. */
  note?: string;
};

type Phase =
  | { kind: 'offer' }
  | { kind: 'running'; runId?: string; workflowId: string }
  | {
      kind: 'ask';
      runId: string;
      workflowId?: string;
      ask: RemixViewerAsk;
      answers: RemixAnswer[];
      prices?: Record<string, number>;
    }
  | { kind: 'priced'; runId: string; workflowId?: string; answers: RemixAnswer[]; cost: number }
  | { kind: 'done'; runId?: string; workflowId: string; outputs: RemixImage[] }
  | { kind: 'failed'; runId?: string; workflowId: string; reason: string };

/** How long a finished segment whose outputs are still being rated waits before asking again. */
const UNRATED_RETRY_MS = 5000;

function openQueue() {
  generationGraphPanel.open(undefined, { preserveEntryAction: true });
  generationGraphPanel.setView('queue');
}

const refetchQueue = () =>
  queryClient
    .invalidateQueries({
      queryKey: getQueryKey(trpc.orchestrator.queryGeneratedImages),
      exact: false,
    })
    .catch(() => null);

/** The price on screen for a new run: the same queries, and so the same cache, as the button. */
function useOfferPrice(slug: string, imageId: number | undefined, enabled: boolean) {
  const isTeam = slug === TEAM_REMIX_SLUG;
  const opts = { staleTime: 3 * 60 * 1000, retry: false } as const;
  const team = trpc.remixApp.teamQuote.useQuery(
    { imageId: imageId ?? 0 },
    { ...opts, enabled: enabled && isTeam && imageId != null }
  );
  const quote = trpc.remixApp.quote.useQuery(
    { imageId: imageId ?? 0 },
    { ...opts, enabled: enabled && !isTeam && imageId != null }
  );
  const price = isTeam
    ? team.data?.price
    : quote.data?.prices.find((p) => p.slug === slug) ?? undefined;
  const query = isTeam ? team : quote;
  return {
    cost: price && 'cost' in price ? price.cost : undefined,
    refusal:
      price && 'refusal' in price
        ? price.refusal
        : query.isError || (isTeam && team.isSuccess && !team.data)
        ? 'Price unavailable. Close this and try again.'
        : undefined,
    loading: query.isLoading,
  };
}

function AskStep({
  ask,
  prices,
  pending,
  onAnswer,
}: {
  ask: RemixViewerAsk;
  prices?: Record<string, number>;
  pending: boolean;
  onAnswer: (answer: RemixAnswer) => void;
}) {
  const [text, setText] = useState('');
  return (
    <div className="flex flex-col gap-3">
      <Text fw={600}>{ask.prompt}</Text>
      {ask.kind === 'choice' && ask.image && (
        <EdgeMedia2
          src={ask.image.url}
          type="image"
          alt=""
          className="mx-auto max-h-72 w-auto rounded-md object-contain"
        />
      )}
      {ask.kind === 'choice' && (
        <div className="flex flex-wrap gap-2">
          {ask.options.map((option) => (
            <Button
              key={option.value}
              variant="default"
              disabled={pending}
              onClick={() => onAnswer(option.value)}
              rightSection={
                prices?.[option.value] ? (
                  <CurrencyBadge currency="BUZZ" unitAmount={prices[option.value]} size="sm" />
                ) : undefined
              }
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}
      {ask.kind === 'pick' && (
        <div className="grid grid-cols-2 gap-2">
          {ask.images.map((image, index) =>
            // One the viewer may not see is left out; the rest keep the index the app gave them.
            image ? (
              <UnstyledButton
                key={image.url}
                aria-label={`Pick image ${index + 1}`}
                disabled={pending}
                onClick={() => onAnswer(index)}
                className="overflow-hidden rounded-md"
              >
                <EdgeMedia2 src={image.url} type="image" alt="" className="w-full object-cover" />
              </UnstyledButton>
            ) : null
          )}
        </div>
      )}
      {ask.kind === 'text' && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onAnswer(text);
          }}
        >
          <TextInput
            className="flex-1"
            aria-label={ask.prompt}
            value={text}
            maxLength={ask.maxLength}
            onChange={(e) => setText(e.currentTarget.value)}
          />
          {ask.optional && (
            <Button variant="default" disabled={pending} onClick={() => onAnswer('')}>
              Skip
            </Button>
          )}
          <Button type="submit" disabled={pending || !text.trim()}>
            Continue
          </Button>
        </form>
      )}
    </div>
  );
}

/**
 * One remix run, from its price to its result. Closing it leaves the run going: the tray holds it,
 * and tapping it there reopens this.
 */
export function RemixAppModalContent({
  app,
  imageId,
  run,
  note,
  onClose,
}: RemixAppModalProps & { onClose: () => void }) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const [phase, setPhase] = useState<Phase>(run ? { kind: 'running', ...run } : { kind: 'offer' });
  // One nonce per offer: a repeated Run of the same offer names the same run.
  const [nonce, setNonce] = useState(() => crypto.randomUUID());
  const [retryTick, setRetryTick] = useState(0);
  const offer = useOfferPrice(app.slug, imageId, phase.kind === 'offer');
  const { workflows, dismiss } = useRemixRuns();

  const start = trpc.remixApp.start.useMutation();
  const runOnce = trpc.remixApp.run.useMutation();
  const advance = trpc.remixApp.advance.useMutation();
  const postRun = trpc.remixApp.post.useMutation();
  const gallery = useResultGallery(
    phase.kind === 'done' && features.remixGallery ? imageId : undefined,
    currentUser?.id
  );
  const pending = start.isPending || runOnce.isPending || advance.isPending;

  const onError = (error: { message: string }) =>
    showErrorNotification({ title: `${app.name} failed`, error: new Error(error.message) });

  /** `answers`: given since the latest segment, carried until a segment records them. */
  function apply(state: RemixRunState, answers: RemixAnswer[] = []) {
    const workflowId = 'workflowId' in state ? state.workflowId : phaseWorkflowId(phase);
    switch (state.status) {
      case 'running':
        if (phase.kind === 'running' && phase.workflowId === state.workflowId)
          // Finished, but its outputs are not rated yet: ask again shortly.
          setTimeout(() => setRetryTick((tick) => tick + 1), UNRATED_RETRY_MS);
        setPhase({ kind: 'running', runId: state.runId, workflowId: state.workflowId });
        break;
      case 'ask':
        setPhase({
          kind: 'ask',
          runId: state.runId,
          workflowId,
          ask: state.ask,
          answers,
          prices: state.prices,
        });
        break;
      case 'priced':
        setPhase({ kind: 'priced', runId: state.runId, workflowId, answers, cost: state.cost });
        break;
      case 'done':
        setPhase({ kind: 'done', ...state });
        break;
      case 'failed':
        setPhase({ kind: 'failed', ...state });
        break;
    }
  }

  const tracked =
    phase.kind === 'running' ? workflows.find((w) => w.id === phase.workflowId) : undefined;
  const trackedFinished = !!tracked && !isRunningWorkflow(tracked);

  // A segment that finished: a runtime run asks the server what comes next; a one-shot run is done.
  useEffect(() => {
    if (phase.kind !== 'running' || !tracked || !trackedFinished || advance.isPending) return;
    if (!app.runtime || !phase.runId) {
      setPhase(
        tracked.status === 'succeeded'
          ? {
              kind: 'done',
              workflowId: phase.workflowId,
              outputs: tracked.succeededOutput.map((output) => ({ url: output.url })),
            }
          : {
              kind: 'failed',
              workflowId: phase.workflowId,
              reason: `This remix ${tracked.status}.`,
            }
      );
      return;
    }
    advance.mutate({ runId: phase.runId }, { onSuccess: (state) => apply(state), onError });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind, trackedFinished, retryTick]);

  /** A tap that submitted a step collapses into the tray, which holds the run until it needs you. */
  function toTray(state: RemixRunState) {
    if (state.status === 'running') onClose();
  }

  function runOffer(cost: number) {
    if (imageId == null) return;
    const input = { slug: app.slug, imageId, nonce };
    const started = () => refetchQueue();
    if (app.runtime)
      start.mutate(
        { ...input, quote: cost },
        {
          onSuccess: (state) => {
            started();
            apply(state);
            toTray(state);
          },
          onError,
        }
      );
    else
      runOnce.mutate(
        { ...input, quote: cost },
        {
          onSuccess: ({ workflowId }) => {
            started();
            setPhase({ kind: 'running', workflowId: workflowId as string });
            onClose();
          },
          onError,
        }
      );
  }

  /** Advances the run; one with no workflow yet has nothing to advance, so it starts again with its answers. */
  function step(
    current: { runId: string; workflowId?: string },
    input: { answers: RemixAnswer[]; quote?: number },
    callbacks: { onSuccess: (state: RemixRunState) => void; onError: typeof onError }
  ) {
    if (current.workflowId) advance.mutate({ runId: current.runId, ...input }, callbacks);
    else if (imageId != null) start.mutate({ slug: app.slug, imageId, nonce, ...input }, callbacks);
  }

  function answer(value: RemixAnswer) {
    if (phase.kind !== 'ask') return;
    const answers = [...phase.answers, value];
    // A priced option's button showed its price: the tap agrees to it and submits.
    const quote = phase.prices?.[String(value)] || undefined;
    step(
      phase,
      { answers, quote },
      {
        onSuccess: (state) => {
          apply(state, answers);
          if (quote) {
            refetchQueue();
            toTray(state);
          }
        },
        onError,
      }
    );
  }

  function continuePriced() {
    if (phase.kind !== 'priced') return;
    const { answers, cost } = phase;
    step(
      phase,
      { answers, quote: cost },
      {
        onSuccess: (state) => {
          refetchQueue();
          apply(state, answers);
          toTray(state);
        },
        onError,
      }
    );
  }

  function remixAgain() {
    setNonce(crypto.randomUUID());
    setPhase({ kind: 'offer' });
  }

  function post(workflowId: string, runId?: string) {
    postRun.mutate(
      runId ? { runId, gallery: gallery.submit } : { workflowId, gallery: gallery.submit },
      {
        onSuccess: (result) => {
          setCachedWorkflowTag(workflowId, REMIX_DONE_TAG, 'add');
          showSuccessNotification({
            title: result.gallery?.submitted ? 'Posted and sent to the Remix gallery' : 'Posted',
            message: <Link href={`/posts/${result.postId}`}>View post</Link>,
          });
          if (result.gallery && !result.gallery.submitted)
            showWarningNotification({
              title: 'Not sent to the Remix gallery',
              message: result.gallery.reason,
            });
          onClose();
        },
        onError: (error) =>
          showErrorNotification({ title: 'Could not post', error: new Error(error.message) }),
      }
    );
  }

  const workflowId = phaseWorkflowId(phase);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Text fw={700} size="lg" className="flex-1" truncate>
          {app.name}
        </Text>
        {workflowId && (
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" aria-label="More">
                <IconDots size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                onClick={() => {
                  dismiss({ workflowId });
                  onClose();
                }}
              >
                Dismiss
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
        <ActionIcon variant="subtle" color="gray" aria-label="Close to tray" onClick={onClose}>
          <IconX size={18} />
        </ActionIcon>
      </div>

      {phase.kind === 'offer' && (
        <div className="flex flex-col gap-3">
          <Text size="sm">
            Runs {app.name} on this image and adds the result to your queue. It runs in the tray, so
            you can keep browsing.
          </Text>
          {offer.refusal && (
            <Text size="sm" c="dimmed">
              {offer.refusal}
            </Text>
          )}
          <Button
            onClick={() => offer.cost != null && runOffer(offer.cost)}
            disabled={offer.cost == null || imageId == null}
            loading={pending}
            rightSection={
              !offer.refusal && (
                <CurrencyBadge
                  currency="BUZZ"
                  unitAmount={offer.cost ?? 0}
                  loading={offer.loading}
                  size="sm"
                />
              )
            }
          >
            Run
          </Button>
        </div>
      )}

      {phase.kind === 'running' && (
        <div className="flex flex-col items-center gap-2 py-6" data-testid="remix-running">
          <Loader size="sm" />
          <Text size="sm" c="dimmed">
            Generating… You can close this; it keeps going in the tray.
          </Text>
          {note && (
            <Text size="xs" c="dimmed" ta="center">
              {note}
            </Text>
          )}
        </div>
      )}

      {phase.kind === 'ask' && (
        <AskStep ask={phase.ask} prices={phase.prices} pending={pending} onAnswer={answer} />
      )}

      {phase.kind === 'priced' && (
        <Button
          onClick={continuePriced}
          loading={pending}
          rightSection={<CurrencyBadge currency="BUZZ" unitAmount={phase.cost} size="sm" />}
        >
          Continue
        </Button>
      )}

      {phase.kind === 'failed' && (
        <Text size="sm" c="red">
          {phase.reason}
        </Text>
      )}

      {phase.kind === 'done' && (
        <div className="grid grid-cols-1 gap-2">
          {phase.outputs.map((output) => (
            // Whole image at its own aspect ratio, never taller than the screen leaves room for.
            <EdgeMedia2
              key={output.url}
              src={output.url}
              type="image"
              alt=""
              className="max-h-[60dvh] w-full rounded-md object-contain"
            />
          ))}
          {!phase.outputs.length && (
            <Text size="sm" c="dimmed">
              Nothing from this remix can be shown here.
            </Text>
          )}
        </div>
      )}

      {(phase.kind === 'done' || phase.kind === 'failed') && (
        <RemixResultLine
          onRemixAgain={remixAgain}
          remixAgainDisabled={imageId == null}
          onOpenQueue={() => {
            openQueue();
            onClose();
          }}
          gallery={gallery.control}
          onPost={() =>
            phase.kind === 'done' && phase.outputs.length && post(phase.workflowId, phase.runId)
          }
          posting={postRun.isPending}
          postDisabled={phase.kind !== 'done' || !phase.outputs.length}
        />
      )}
    </div>
  );
}

/**
 * The Remix gallery switch for a finished run: priced from the source's gallery, on by default
 * only when it costs no Buzz. A choice is kept for the price it was made at, so a switch turned on
 * while free never carries over to a paid offer.
 */
function useResultGallery(hostImageId: number | undefined, viewerId: number | undefined) {
  const enabled = hostImageId != null && viewerId != null;
  const { data: visibility } = trpc.placement.getRemixGalleryVisibility.useQuery(
    { imageId: hostImageId ?? 0 },
    { enabled }
  );
  const { data: eligibility } = trpc.placement.getRemixGalleryFreeEligibility.useQuery(
    { hostImageId: hostImageId ?? 0, imageIds: [] },
    { enabled }
  );
  const [choice, setChoice] = useState<{ method: string; on: boolean } | null>(null);
  const offer = enabled ? remixResultGalleryOffer({ visibility, eligibility, viewerId }) : null;
  if (!offer || hostImageId == null) return { control: undefined, submit: undefined };

  const on = choice?.method === offer.method ? choice.on : offer.method !== 'paid';
  return {
    control: {
      checked: on,
      onChange: (checked: boolean) => setChoice({ method: offer.method, on: checked }),
      price:
        offer.method === 'paid' ? (
          <CurrencyBadge currency="BUZZ" unitAmount={offer.price} size="xs" />
        ) : offer.method === 'team' ? (
          `free for Team ${offer.team}`
        ) : (
          'free'
        ),
    },
    submit: on
      ? {
          hostImageId,
          method: offer.method,
          expectedPrice: offer.method === 'paid' ? offer.price : undefined,
        }
      : undefined,
  };
}

function phaseWorkflowId(phase: Phase) {
  return 'workflowId' in phase ? phase.workflowId : undefined;
}

export function RemixAppModal(props: RemixAppModalProps) {
  const dialog = useDialogContext();
  return (
    <Modal {...dialog} withCloseButton={false} size="md" centered>
      <RemixAppModalContent {...props} onClose={dialog.onClose} />
    </Modal>
  );
}
