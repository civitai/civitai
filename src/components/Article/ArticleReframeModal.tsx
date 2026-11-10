import { Alert, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { getQueryKey } from '@trpc/react-query';
import { useState } from 'react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useGetTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { isRunningWorkflow } from '~/components/Image/Remix/useRemixRuns';
import type { ImageSchema } from '~/server/schema/image.schema';
import {
  ARTICLE_REFRAME,
  ARTICLE_REFRAME_TAG,
  centreCropBox,
  type ArticleReframeTarget,
} from '~/shared/utils/article-reframe';
import { showErrorNotification } from '~/utils/notifications';
import { queryClient, trpc } from '~/utils/trpc';

type Props = {
  source: { id: number; url: string };
  target: ArticleReframeTarget;
  /** Called once, on Keep. Nothing reaches the form before it. */
  onKeep: (image: ImageSchema) => void;
};

export function openArticleReframeModal(props: Props) {
  dialogStore.trigger({ component: ArticleReframeModal, props });
}

const QUERY_INPUT = { tags: [ARTICLE_REFRAME_TAG] };

export function ArticleReframeModal(props: Props) {
  const dialog = useDialogContext();
  const noun = props.target === 'banner' ? 'banner' : 'cover';
  return (
    <Modal {...dialog} title={`Generate a ${noun}`} size="lg">
      <ArticleReframeContent {...props} onClose={dialog.onClose} />
    </Modal>
  );
}

export function ArticleReframeContent({
  source,
  target,
  onKeep,
  onClose,
}: Props & { onClose: () => void }) {
  const [workflowId, setWorkflowId] = useState<string>();
  // One nonce per take: a repeated tap on the same take names the same workflow.
  const [nonce, setNonce] = useState(() => crypto.randomUUID());
  const { keepAspect, targetWidth, app } = ARTICLE_REFRAME[target];
  const keptWidth = (width: number, height: number) =>
    centreCropBox(width, height, keepAspect).width;
  const noun = target === 'banner' ? 'banner' : 'cover';

  const quote = trpc.article.reframeQuote.useQuery(
    { imageId: source.id, target },
    { enabled: !workflowId, retry: false, refetchOnWindowFocus: false }
  );
  const submit = trpc.article.reframeSubmit.useMutation();
  const keep = trpc.article.reframeKeep.useMutation();

  const { data: workflows } = useGetTextToImageRequests(QUERY_INPUT, {
    enabled: !!workflowId,
    includeTags: false,
    ignoreFilters: true,
  });
  const workflow = workflows.find((w) => w.id === workflowId);
  const take = workflow?.succeededOutput.find((output) => output.type === 'image');
  // A finished take is held back until it is rated, so it still counts as generating.
  const running =
    !!workflowId &&
    (!workflow ||
      isRunningWorkflow(workflow) ||
      (!take && workflow.pendingRatingOutput.length > 0));
  const failed = !!workflow && !running && !take;

  function generate() {
    if (!quote.data) return;
    submit.mutate(
      { imageId: source.id, target, quote: quote.data.cost, nonce },
      {
        onSuccess: ({ workflowId }) => {
          setWorkflowId(workflowId);
          queryClient.invalidateQueries({
            queryKey: getQueryKey(trpc.orchestrator.queryGeneratedImages),
            exact: false,
          });
        },
        onError: (error) =>
          showErrorNotification({ title: 'Could not generate', error: new Error(error.message) }),
      }
    );
  }

  function retry() {
    setWorkflowId(undefined);
    setNonce(crypto.randomUUID());
  }

  function keepTake() {
    if (!workflowId) return;
    keep.mutate(
      { workflowId, target },
      {
        onSuccess: (image) => {
          onKeep({ ...image, type: 'image' } as ImageSchema);
          onClose();
        },
        onError: (error) =>
          showErrorNotification({
            title: 'Could not keep this take',
            error: new Error(error.message),
          }),
      }
    );
  }

  return (
    <Stack>
      <Text size="sm" c="dimmed">
        AI re-imagines your image at the {noun} shape. It can change details, and the{' '}
        {target === 'banner' ? 'top and bottom are' : 'edges are'} trimmed to fit. Nothing changes
        in your article until you keep a take and save.
      </Text>

      {!workflowId && (
        <>
          <EdgeMedia src={source.url} width={450} className="max-h-60 w-full object-contain" />
          {quote.isError ? (
            <Alert color="yellow">{quote.error.message}</Alert>
          ) : (
            <Button
              onClick={generate}
              disabled={!quote.data?.ready}
              loading={quote.isLoading || submit.isPending}
              rightSection={
                <CurrencyBadge
                  currency="BUZZ"
                  unitAmount={quote.data?.cost ?? 0}
                  loading={quote.isLoading}
                  size="sm"
                />
              }
            >
              Generate {noun}
            </Button>
          )}
        </>
      )}

      {running && (
        <Group justify="center" py="xl">
          <Loader />
          <Text size="sm">Generating your {noun}…</Text>
        </Group>
      )}

      {failed && (
        <Alert color="red">
          This take did not produce an image. {app.name} failed or was blocked; try again.
        </Alert>
      )}

      {take?.width && take.height && keptWidth(take.width, take.height) < targetWidth ? (
        <Text size="xs" c="dimmed">
          This take is narrower than the suggested {targetWidth}px, so it may look soft.
        </Text>
      ) : null}
      {take && (
        <TakeWithCrop
          url={take.url}
          width={take.width ?? 0}
          height={take.height ?? 0}
          aspect={keepAspect}
        />
      )}

      {workflowId && !running && (
        <Group justify="flex-end">
          <Button variant="default" onClick={retry} disabled={keep.isPending}>
            Retry
          </Button>
          {take && (
            <Button onClick={keepTake} loading={keep.isPending}>
              Keep as {noun}
            </Button>
          )}
        </Group>
      )}
    </Stack>
  );
}

/** The take, with the part that will be trimmed dimmed. */
function TakeWithCrop({
  url,
  width,
  height,
  aspect,
}: {
  url: string;
  width: number;
  height: number;
  aspect: number;
}) {
  const box = width && height ? centreCropBox(width, height, aspect) : undefined;
  return (
    <div className="relative w-full overflow-hidden rounded-md">
      <EdgeMedia src={url} type="image" alt="Generated take" className="block w-full" />
      {box && (
        <div
          className="pointer-events-none absolute border-2 border-white"
          style={{
            left: `${(box.left / width) * 100}%`,
            top: `${(box.top / height) * 100}%`,
            width: `${(box.width / width) * 100}%`,
            height: `${(box.height / height) * 100}%`,
            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.55)',
          }}
        />
      )}
    </div>
  );
}
