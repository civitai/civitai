import { ActionIcon, Button, Loader, Modal, Text, TextInput, UnstyledButton } from '@mantine/core';
import { Menu } from '~/components/MantineOverlays';
import { IconDots, IconX } from '@tabler/icons-react';
import { getQueryKey } from '@trpc/react-query';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { RemixResultLine } from '~/components/Image/Remix/RemixResultLine';
import { isRunningWorkflow, useRemixRuns } from '~/components/Image/Remix/useRemixRuns';
import { postGeneratedMedia } from '~/components/ImageGeneration/utils/postGeneratedMedia';
import { useShowCreatePostError } from '~/components/Post/showCreatePostError';
import type { RemixRunState } from '~/server/services/remix-app-run.service';
import { TEAM_REMIX_SLUG } from '~/shared/constants/remix-apps.constants';
import type { RemixAnswer, RemixAsk, RemixImage } from '~/shared/remix-apps/define';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { showErrorNotification } from '~/utils/notifications';
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
  | { kind: 'ask'; runId: string; workflowId?: string; ask: RemixAsk; answers: RemixAnswer[] }
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
  pending,
  onAnswer,
}: {
  ask: RemixAsk;
  pending: boolean;
  onAnswer: (answer: RemixAnswer) => void;
}) {
  const [text, setText] = useState('');
  return (
    <div className="flex flex-col gap-3">
      <Text fw={600}>{ask.prompt}</Text>
      {ask.kind === 'choice' && (
        <div className="flex flex-wrap gap-2">
          {ask.options.map((option) => (
            <Button
              key={option.value}
              variant="default"
              disabled={pending}
              onClick={() => onAnswer(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}
      {ask.kind === 'pick' && (
        <div className="grid grid-cols-2 gap-2">
          {ask.images.map((image, index) => (
            <UnstyledButton
              key={image.url}
              aria-label={`Pick image ${index + 1}`}
              disabled={pending}
              onClick={() => onAnswer(index)}
              className="overflow-hidden rounded-md"
            >
              <EdgeMedia2 src={image.url} type="image" alt="" className="w-full object-cover" />
            </UnstyledButton>
          ))}
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
            value={text}
            maxLength={ask.maxLength}
            onChange={(e) => setText(e.currentTarget.value)}
          />
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
  const router = useRouter();
  const showCreatePostError = useShowCreatePostError();
  const [phase, setPhase] = useState<Phase>(run ? { kind: 'running', ...run } : { kind: 'offer' });
  // One nonce per offer: a repeated Run of the same offer names the same run.
  const [nonce, setNonce] = useState(() => crypto.randomUUID());
  const [retryTick, setRetryTick] = useState(0);
  const offer = useOfferPrice(app.slug, imageId, phase.kind === 'offer');
  const { workflows, dismiss } = useRemixRuns();

  const start = trpc.remixApp.start.useMutation();
  const runOnce = trpc.remixApp.run.useMutation();
  const advance = trpc.remixApp.advance.useMutation();
  const createPost = trpc.post.create.useMutation();
  const [posting, setPosting] = useState(false);
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
        setPhase({ kind: 'ask', runId: state.runId, workflowId, ask: state.ask, answers });
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
          },
          onError,
        }
      );
    else
      runOnce.mutate(input, {
        onSuccess: ({ workflowId }) => {
          started();
          setPhase({ kind: 'running', workflowId: workflowId as string });
        },
        onError,
      });
  }

  function answer(value: RemixAnswer) {
    if (phase.kind !== 'ask') return;
    const answers = [...phase.answers, value];
    advance.mutate(
      { runId: phase.runId, answers },
      { onSuccess: (state) => apply(state, answers), onError }
    );
  }

  function continuePriced() {
    if (phase.kind !== 'priced') return;
    const { runId, answers, cost } = phase;
    advance.mutate(
      { runId, answers, quote: cost },
      {
        onSuccess: (state) => {
          refetchQueue();
          apply(state, answers);
        },
        onError,
      }
    );
  }

  function remixAgain() {
    setNonce(crypto.randomUUID());
    setPhase({ kind: 'offer' });
  }

  async function post(outputs: RemixImage[], workflowId: string) {
    setPosting(true);
    try {
      await postGeneratedMedia({
        media: outputs.map(({ url }) => ({ url, generationWorkflowId: workflowId })),
        router,
        createPost: () => createPost.mutateAsync({}),
      });
      onClose();
    } catch (e) {
      showCreatePostError(e as Error);
    } finally {
      setPosting(false);
    }
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
            Runs {app.name} on this image and adds the result to your queue. You can close this
            while it runs.
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

      {phase.kind === 'ask' && <AskStep ask={phase.ask} pending={pending} onAnswer={answer} />}

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
          onPost={() =>
            phase.kind === 'done' && phase.outputs.length && post(phase.outputs, phase.workflowId)
          }
          posting={posting}
          postDisabled={phase.kind !== 'done' || !phase.outputs.length}
        />
      )}
    </div>
  );
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
