import { ActionIcon, Button, Loader, Modal, Text, TextInput, UnstyledButton } from '@mantine/core';
import { Menu } from '~/components/MantineOverlays';
import { IconDots, IconX } from '@tabler/icons-react';
import { getQueryKey } from '@trpc/react-query';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { openDialog } from '~/components/Dialog/openDialog';
import { RemixResultLine } from '~/components/Image/Remix/RemixResultLine';
import { isRunningWorkflow, useRemixRuns } from '~/components/Image/Remix/useRemixRuns';
import { setCachedWorkflowTag } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { remixResultGalleryOffer } from '~/components/RemixGallery/remix-gallery.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { RemixRunState } from '~/server/services/remix-app-run.service';
import { TEAM_REMIX_SLUG } from '~/shared/constants/remix-apps.constants';
import { compileRemixApp, type RemixAppListing } from '~/shared/remix-apps/compile';
import type {
  RemixAnswer,
  RemixAppSource,
  RemixImage,
  RemixViewerAsk,
} from '~/shared/remix-apps/define';
import { MOCK_IMAGE_URL_PREFIX, mockResult } from '~/shared/remix-apps/mock-host';
import {
  REMIX_IMAGE_STAND_IN,
  replayRemixApp,
  type RemixLogEntry,
} from '~/shared/remix-apps/replay';
import { type RemixDeclarativeSpec, USER_REMIX_SLUG } from '~/shared/remix-apps/row.schema';
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

/** A preview's stand-in for the run and workflow ids a real run has. */
const PREVIEW_WORKFLOW_ID = 'preview';

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
  // A user app is priced alone, when its modal opens; a system app shares the menu's quote.
  const quote = trpc.remixApp.quote.useQuery(
    { imageId: imageId ?? 0, ...(USER_REMIX_SLUG.test(slug) ? { slug } : {}) },
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

/** One of the viewer's own images; the server checks it is theirs and may be used. */
export function ImageAskStep({
  ask,
  pending,
  onAnswer,
}: {
  ask: Extract<RemixViewerAsk, { kind: 'image' }>;
  pending: boolean;
  onAnswer: (answer: RemixAnswer) => void;
}) {
  const [picked, setPicked] = useState<{ id: number; url: string }>();
  const choose = () =>
    openDialog(() => import('~/components/Training/Form/ImageSelectModal'), {
      title: ask.prompt,
      selectSource: 'uploaded' as const,
      videoAllowed: false,
      importedUrls: [],
      onSelect: (selected: { url: string; imageId?: number }[]) => {
        const [first] = selected;
        if (first?.imageId) setPicked({ id: first.imageId, url: first.url });
      },
    });
  return (
    <div className="flex flex-col gap-2">
      {picked && (
        <EdgeMedia2
          src={picked.url}
          type="image"
          alt=""
          className="mx-auto max-h-72 w-auto rounded-md object-contain"
        />
      )}
      <div className="flex gap-2">
        <Button variant="default" disabled={pending} onClick={choose}>
          {picked ? 'Choose another' : 'Choose one of your images'}
        </Button>
        {ask.optional && (
          <Button variant="default" disabled={pending} onClick={() => onAnswer('')}>
            Skip
          </Button>
        )}
        <Button disabled={pending || !picked} onClick={() => picked && onAnswer(picked.id)}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function AskStep({
  ask,
  prices,
  pending,
  preview,
  onAnswer,
}: {
  ask: RemixViewerAsk;
  prices?: Record<string, number>;
  pending: boolean;
  /** A preview answers an image ask with the source itself, so it never opens the image picker. */
  preview: boolean;
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
      {ask.kind === 'image' &&
        (preview ? (
          <div className="flex gap-2">
            {ask.optional && (
              <Button variant="default" disabled={pending} onClick={() => onAnswer('')}>
                Skip
              </Button>
            )}
            <Button disabled={pending} onClick={() => onAnswer(REMIX_IMAGE_STAND_IN)}>
              Use this image for the preview
            </Button>
          </div>
        ) : (
          <ImageAskStep ask={ask} pending={pending} onAnswer={onAnswer} />
        ))}
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

/** What the modal shows and does, from whichever driver runs it. */
type RemixModalDriver = {
  phase: Phase;
  pending: boolean;
  offer: { cost?: number; refusal?: string; loading: boolean; disabled: boolean };
  run: () => void;
  answer: (value: RemixAnswer) => void;
  continuePriced: () => void;
  remixAgain: () => void;
  remixAgainDisabled: boolean;
  /** Absent for a preview, which generates nothing: there is nothing to dismiss, queue or post. */
  live?: {
    dismiss: (workflowId: string) => void;
    openQueue: () => void;
    gallery: ReturnType<typeof useResultGallery>['control'];
    post: (workflowId: string, runId?: string) => void;
    posting: boolean;
  };
};

function RemixModalView({
  name,
  driver,
  note,
  onClose,
}: {
  name: string;
  driver: RemixModalDriver;
  note?: string;
  onClose: () => void;
}) {
  const { phase, pending, offer, live } = driver;
  const workflowId = phaseWorkflowId(phase);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Text fw={700} size="lg" className="flex-1" truncate>
          {name}
        </Text>
        {live && workflowId && (
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" aria-label="More">
                <IconDots size={18} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                onClick={() => {
                  live.dismiss(workflowId);
                  onClose();
                }}
              >
                Dismiss
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={live ? 'Close to tray' : 'Close'}
          onClick={onClose}
        >
          <IconX size={18} />
        </ActionIcon>
      </div>

      {phase.kind === 'offer' && (
        <div className="flex flex-col gap-3">
          <Text size="sm">
            {live
              ? `Runs ${name} on this image and adds the result to your queue. It runs in the tray, so you can keep browsing.`
              : `Walks through ${name} on this image with placeholder results. Nothing is generated or charged.`}
          </Text>
          {offer.refusal && (
            <Text size="sm" c="dimmed">
              {offer.refusal}
            </Text>
          )}
          <Button
            onClick={driver.run}
            disabled={offer.disabled}
            loading={pending}
            rightSection={
              live &&
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
            {live ? 'Run' : 'Preview'}
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
        <AskStep
          ask={phase.ask}
          prices={phase.prices}
          pending={pending}
          preview={!live}
          onAnswer={driver.answer}
        />
      )}

      {phase.kind === 'priced' && (
        <Button
          onClick={driver.continuePriced}
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
            <RemixOutput key={output.url} image={output} />
          ))}
          {!phase.outputs.length && (
            <Text size="sm" c="dimmed">
              Nothing from this remix can be shown here.
            </Text>
          )}
        </div>
      )}

      {(phase.kind === 'done' || phase.kind === 'failed') &&
        (live ? (
          <RemixResultLine
            onRemixAgain={driver.remixAgain}
            remixAgainDisabled={driver.remixAgainDisabled}
            onOpenQueue={() => {
              live.openQueue();
              onClose();
            }}
            gallery={live.gallery}
            onPost={() =>
              phase.kind === 'done' &&
              phase.outputs.length &&
              live.post(phase.workflowId, phase.runId)
            }
            posting={live.posting}
            postDisabled={phase.kind !== 'done' || !phase.outputs.length}
          />
        ) : (
          <Button variant="default" onClick={driver.remixAgain}>
            Preview again
          </Button>
        ))}
    </div>
  );
}

/** Whole image at its own aspect ratio; a preview's placeholder is a labelled box of that shape. */
function RemixOutput({ image }: { image: RemixImage }) {
  if (!image.url.startsWith(MOCK_IMAGE_URL_PREFIX))
    return (
      <EdgeMedia2
        src={image.url}
        type="image"
        alt=""
        className="max-h-[60dvh] w-full rounded-md object-contain"
      />
    );
  return (
    <div
      data-testid="remix-preview-output"
      className="flex max-h-[60dvh] w-full items-center justify-center rounded-md bg-gray-2 dark:bg-dark-5"
      style={{ aspectRatio: `${image.width ?? 1} / ${image.height ?? 1}` }}
    >
      <Text size="sm" c="dimmed">
        Preview
      </Text>
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
  const driver = useLiveRemixDriver({ app, imageId, run, onClose });
  return <RemixModalView name={app.name} driver={driver} note={note} onClose={onClose} />;
}

/**
 * An unsaved declarative app, run in the browser over placeholder results: the same modal as a
 * real run, with no request to the server.
 */
export function RemixDraftModalContent({
  listing,
  spec,
  source,
  onClose,
}: {
  listing: RemixAppListing;
  spec: RemixDeclarativeSpec;
  source: RemixAppSource;
  onClose: () => void;
}) {
  const driver = useDraftRemixDriver(listing, spec, source);
  return <RemixModalView name={listing.name} driver={driver} onClose={onClose} />;
}

function useDraftRemixDriver(
  listing: RemixAppListing,
  spec: RemixDeclarativeSpec,
  source: RemixAppSource
): RemixModalDriver {
  const app = useMemo(() => compileRemixApp(listing, spec), [listing, spec]);
  const [phase, setPhase] = useState<Phase>({ kind: 'offer' });
  const [log, setLog] = useState<RemixLogEntry[]>([]);
  const [pending, setPending] = useState(false);

  /** Replays from `from`, answering every workflow with placeholders, up to the next ask or the end. */
  async function playFrom(from: RemixLogEntry[]) {
    setPending(true);
    const entries = [...from];
    try {
      // Replay refuses a run past the effect limit, so this ends.
      for (;;) {
        const outcome = await replayRemixApp(app, source, entries);
        if (outcome.status === 'done') {
          setPhase({ kind: 'done', workflowId: PREVIEW_WORKFLOW_ID, outputs: outcome.outputs });
          break;
        }
        const { effect, index } = outcome;
        if (effect.type === 'ask') {
          setPhase({ kind: 'ask', runId: PREVIEW_WORKFLOW_ID, ask: effect.spec, answers: [] });
          break;
        }
        entries.push({ type: 'workflow', result: mockResult(effect.request, index) });
      }
      setLog(entries);
    } catch (error) {
      setPhase({
        kind: 'failed',
        workflowId: PREVIEW_WORKFLOW_ID,
        reason: error instanceof Error ? error.message : 'This preview failed.',
      });
    } finally {
      setPending(false);
    }
  }

  return {
    phase,
    pending,
    offer: { loading: false, disabled: pending },
    run: () => playFrom([]),
    answer: (value) => playFrom([...log, { type: 'ask', answer: value }]),
    continuePriced: () => undefined,
    remixAgain: () => {
      setLog([]);
      setPhase({ kind: 'offer' });
    },
    remixAgainDisabled: false,
  };
}

/** A run on the server: priced, charged, followed through the tray. */
function useLiveRemixDriver({
  app,
  imageId,
  run,
  onClose,
}: Omit<RemixAppModalProps, 'note'> & { onClose: () => void }): RemixModalDriver {
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

  return {
    phase,
    pending,
    offer: { ...offer, disabled: offer.cost == null || imageId == null },
    run: () => {
      if (offer.cost != null) runOffer(offer.cost);
    },
    answer,
    continuePriced,
    remixAgain,
    remixAgainDisabled: imageId == null,
    live: {
      dismiss: (workflowId) => dismiss({ workflowId }),
      openQueue,
      gallery: gallery.control,
      post,
      posting: postRun.isPending,
    },
  };
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
