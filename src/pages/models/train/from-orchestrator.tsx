import {
  Anchor,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import { TRAINING_WORKFLOW_TAG } from '~/server/services/orchestrator/training/workflow-state';
import type {
  PublishRefusalReason,
  PublishTarget,
} from '~/server/services/orchestrator/training/publish-from-workflow';
import {
  createDraftModelFromWorkflow,
  createDraftVersionFromWorkflow,
  getPublishRefusalReason,
  getRunDestination,
  getStudioVersionTargets,
  stampWorkflowDraftModel,
} from '~/server/services/orchestrator/training/publish-from-workflow';
import { env } from '~/env/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { dbWrite } from '~/server/db/client';
import { getLoginLink } from '~/utils/login-helpers';
import { Flags } from '~/shared/utils/flags';
import type { TrainingDataShare } from '~/server/services/training-data-share.service';
import {
  getStudioDatasetShare,
  raisesTrainingDataShare,
  setStudioDatasetShare,
  trainingDataShareFromQuery,
} from '~/server/services/training-data-share.service';
import { OnboardingSteps } from '~/server/common/enums';
import { getConsumerBlobId } from '~/shared/orchestrator/blob-url';
import type { BaseModel } from '~/shared/constants/basemodel.constants';
import type { Session } from '~/types/session';
import { TrainingStatus } from '~/shared/utils/prisma/enums';
import { orchestratorMediaTransmitter } from '~/store/post-image-transmitter.store';
import { getModelFileFormat } from '~/utils/file-helpers';
import { bytesToKB } from '~/utils/number-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { forwardQuery } from '~/utils/forward-query';
import { trpc } from '~/utils/trpc';

// A new model goes through the MODEL wizard: for trained uploads its steps are
// Select File → Edit model → Edit version → Post, and "Edit model" (title, description, tags)
// exists nowhere else — studio-born drafts are synthesized, so the user has never seen it. A version
// added to an existing model goes through the VERSION wizard (Select File → Edit version → Post),
// whose step numbers line up.
const wizardUrl = (target: PublishTarget, modelId: number, modelVersionId: number, step: number) =>
  target === 'new-model'
    ? `/models/${modelId}/wizard?step=${step}&modelVersionId=${modelVersionId}`
    : `/models/${modelId}/model-versions/${modelVersionId}/wizard?step=${step}`;

/** Builds this page's URL from `query`; a value of `undefined` omits that param. */
const pageUrl = (query: Record<string, string | string[] | undefined>) =>
  `/models/train/from-orchestrator${forwardQuery(query)}`;

type PrepareProps = {
  target: PublishTarget;
  modelId: number;
  modelVersionId: number;
  versionName: string;
  baseModel: string;
  epochUrl: string;
  sampleImages: string[];
  existingModelFileId: number | null;
};

type Refusal = PublishRefusalReason | 'not-found' | 'unavailable';
type RefusalProps = { refusal: Refusal };

/** The publish link asked to share more than the owner has confirmed on this site. */
type ConfirmShareProps = {
  confirmShare: TrainingDataShare & { modelVersionId: number; continueUrl: string };
};

type PickModelProps = {
  pickModel: {
    query: string;
    models: Awaited<ReturnType<typeof getStudioVersionTargets>>;
    /** Each model's link: this page with `modelId` set. */
    baseQuery: Record<string, string | string[] | undefined>;
    newModelUrl: string;
  };
};

type PageProps = { session: Session } & (
  | PrepareProps
  | RefusalProps
  | ConfirmShareProps
  | PickModelProps
);

export const getServerSideProps = createServerSideProps<PageProps>({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    if (!session?.user)
      return {
        redirect: { destination: getLoginLink({ returnUrl: ctx.resolvedUrl }), permanent: false },
      };

    // A banned, muted or not-yet-onboarded user can't create a model.
    if (
      session.user.bannedAt ||
      session.user.muted ||
      !Flags.hasFlag(session.user.onboarding, OnboardingSteps.Buzz)
    )
      return { redirect: { destination: '/models', permanent: false } };

    const workflowId = typeof ctx.query.workflowId === 'string' ? ctx.query.workflowId : undefined;
    const epoch = typeof ctx.query.epoch === 'string' ? Number(ctx.query.epoch) : NaN;
    if (!workflowId || !Number.isFinite(epoch))
      return { redirect: { destination: '/models', permanent: false } };

    const refuse = (refusal: Refusal) => ({ props: { session, refusal } });
    const addToExisting = ctx.query.target === 'existing';
    const targetModelId =
      typeof ctx.query.modelId === 'string' ? Number(ctx.query.modelId) : undefined;
    if (
      addToExisting &&
      targetModelId !== undefined &&
      !(Number.isSafeInteger(targetModelId) && targetModelId > 0)
    )
      return refuse('model-not-eligible');

    let token: string;
    try {
      token = await getOrchestratorToken(session.user.id, {
        req: ctx.req as unknown as NextApiRequest,
        res: ctx.res as unknown as NextApiResponse,
      });
    } catch (e) {
      if (e instanceof TRPCError && e.code === 'FORBIDDEN')
        return { redirect: { destination: '/models', permanent: false } };
      throw e;
    }
    // A workflow the caller doesn't own returns NOT_FOUND from the orchestrator — that IS the ownership
    // check. A transient upstream fault (503) is NOT "not found" — let it surface as an error page the
    // user can retry, rather than telling them the run doesn't exist.
    let workflow;
    try {
      workflow = await getWorkflow({ token, path: { workflowId } });
    } catch (e) {
      if (e instanceof TRPCError && e.code === 'NOT_FOUND') return refuse('not-found');
      throw e;
    }
    if (!workflow || !workflow.tags?.includes(TRAINING_WORKFLOW_TAG)) return refuse('not-found');

    const refuseFor = (error: unknown) =>
      error instanceof TRPCError && error.code === 'NOT_FOUND'
        ? refuse('not-found')
        : refuse(getPublishRefusalReason(error) ?? 'unavailable');

    if (addToExisting && targetModelId === undefined) {
      try {
        // A run that already has a draft resumes it: the picker never offers a second one.
        const destination = await getRunDestination({ user: session.user, workflow });
        if (destination)
          return {
            redirect: {
              destination: pageUrl({
                ...ctx.query,
                target: destination.target === 'existing-model' ? 'existing' : undefined,
                modelId:
                  destination.target === 'existing-model' ? String(destination.modelId) : undefined,
              }),
              permanent: false,
            },
          };
        const query = typeof ctx.query.q === 'string' ? ctx.query.q.slice(0, 100) : '';
        const models = await getStudioVersionTargets({
          userId: session.user.id,
          workflow,
          query,
        });
        const { q: _q, ...baseQuery } = ctx.query;
        return {
          props: {
            session,
            pickModel: {
              query,
              models,
              baseQuery,
              newModelUrl: pageUrl({ ...baseQuery, target: undefined }),
            },
          },
        };
      } catch (error) {
        return refuseFor(error);
      }
    }

    let draft: Awaited<ReturnType<typeof createDraftModelFromWorkflow>>;
    try {
      draft =
        addToExisting && targetModelId !== undefined
          ? await createDraftVersionFromWorkflow({
              user: session.user,
              workflow,
              selectedEpochNumber: epoch,
              modelId: targetModelId,
            })
          : await createDraftModelFromWorkflow({
              user: session.user,
              workflow,
              selectedEpochNumber: epoch,
            });
    } catch (error) {
      return refuseFor(error);
    }
    const { modelId, modelVersionId, selectedEpoch, target } = draft;

    await stampWorkflowDraftModel({ token, workflow, modelId, modelVersionId });

    // A link can be crafted by anyone, so the share it carries is applied only as far as it lowers
    // the stored one; anything more waits for the owner's click on this page.
    const requested = trainingDataShareFromQuery(ctx.query);
    if (requested) {
      await setStudioDatasetShare(modelVersionId, requested);
      const stored = await getStudioDatasetShare(modelVersionId);
      if (stored && raisesTrainingDataShare(stored, requested))
        return {
          props: {
            session,
            confirmShare: {
              ...requested,
              modelVersionId,
              continueUrl: pageUrl({
                workflowId,
                epoch: String(epoch),
                ...(addToExisting && { target: 'existing', modelId: String(modelId) }),
              }),
            },
          },
        };
    }

    const [version, existingModelFile] = await Promise.all([
      dbWrite.modelVersion.findUnique({
        where: { id: modelVersionId },
        select: { name: true, baseModel: true },
      }),
      dbWrite.modelFile.findFirst({
        where: { modelVersionId, type: 'Model' },
        select: { id: true, metadata: true },
      }),
    ]);
    if (!version) return refuse('not-found');

    // Re-entry on an already-materialized draft whose blobs have since expired: nothing left to
    // finalize, so land in the wizard — step 2 if a model file exists, else the manual picker,
    // which still renders from the stored trainingResults metadata.
    if (!selectedEpoch)
      return {
        redirect: {
          destination: wizardUrl(target, modelId, modelVersionId, existingModelFile ? 2 : 1),
          permanent: false,
        },
      };

    // The stored selectedEpochUrl and the freshly-fetched workflow URL carry different signatures
    // for the same blob, so compare by blob id, not by string.
    const storedEpochUrl = (existingModelFile?.metadata as { selectedEpochUrl?: string } | null)
      ?.selectedEpochUrl;
    const selectedBlobId = getConsumerBlobId(selectedEpoch.modelUrl);
    if (storedEpochUrl && selectedBlobId && getConsumerBlobId(storedEpochUrl) === selectedBlobId)
      return {
        redirect: {
          destination: wizardUrl(target, modelId, modelVersionId, 2),
          permanent: false,
        },
      };

    return {
      props: {
        session,
        target,
        modelId,
        modelVersionId,
        versionName: version.name,
        baseModel: version.baseModel,
        epochUrl: selectedEpoch.modelUrl,
        // '' is a failed sample's slot, not an image.
        sampleImages: (selectedEpoch.sampleImages ?? []).filter(Boolean),
        existingModelFileId: existingModelFile?.id ?? null,
      },
    };
  },
});

export default function TrainFromOrchestratorPage(
  props: PrepareProps | RefusalProps | ConfirmShareProps | PickModelProps
) {
  if ('refusal' in props) return <PublishRefused refusal={props.refusal} />;
  if ('confirmShare' in props) return <ConfirmShare {...props.confirmShare} />;
  if ('pickModel' in props) return <PickModel {...props.pickModel} />;
  return <PrepareModel {...props} />;
}

const refusalMessages: Record<Refusal, string> = {
  'not-approved':
    'This training run’s dataset hasn’t been approved, so a model can’t be created from it. If the dataset is still being reviewed, try again once the review is complete.',
  'unsupported-base':
    'Models trained on this base model can’t be published as a model page yet. Your run and its checkpoints are still available in Training Studio.',
  'no-checkpoint':
    'This training run has no checkpoint left to publish. Checkpoints are only kept for a limited time after training finishes.',
  'model-not-eligible':
    'This training run can only be added as a new version of one of your own LoRA models that isn’t private, archived or taken down.',
  'already-published-elsewhere':
    'This training run already has a model page or draft on Civitai. Delete it to publish the run somewhere else.',
  'not-found': 'We couldn’t find this training run on your account.',
  unavailable: 'We couldn’t create a model page from this training run. Please try again later.',
};

function ConfirmShare({
  modelVersionId,
  ownRights,
  shareDataset,
  continueUrl,
}: ConfirmShareProps['confirmShare']) {
  const router = useRouter();
  const setShare = trpc.training.setStudioDatasetShare.useMutation({
    onSuccess: () => router.replace(continueUrl),
    onError: (error) => showErrorNotification({ title: 'Could not save your choice', error }),
  });
  const confirm = () => setShare.mutate({ modelVersionId, ownRights, shareDataset });

  return (
    <>
      <Meta title="Share your training dataset?" deIndex />
      <Center h="60vh">
        <Stack align="center" gap="md" maw={480}>
          <Text ta="center" fw={600}>
            {shareDataset ? 'Share your training dataset?' : 'Confirm your rights to this dataset'}
          </Text>
          <Text ta="center" size="sm">
            {shareDataset
              ? 'You have the right, or the rightholder’s explicit permission, to redistribute all the files in this dataset, and you want it shared with the published model. Shared datasets can be downloaded from the model page once it’s published.'
              : 'You have the right, or the rightholder’s explicit permission, to use all the files in this dataset for training. It stays available only to you.'}{' '}
            <Anchor href="/content/training/data-policy" target="_blank" rel="noopener">
              Dataset storage policy
            </Anchor>
          </Text>
          <Group justify="center">
            <Button onClick={confirm} loading={setShare.isPending}>
              {shareDataset ? 'Share dataset and continue' : 'Confirm and continue'}
            </Button>
            <Button
              variant="default"
              disabled={setShare.isPending}
              onClick={() => router.replace(continueUrl)}
            >
              Continue without {shareDataset ? 'sharing' : 'confirming'}
            </Button>
          </Group>
        </Stack>
      </Center>
    </>
  );
}

function PickModel({ query, models, baseQuery, newModelUrl }: PickModelProps['pickModel']) {
  return (
    <>
      <Meta title="Add as a new version" deIndex />
      <div className="container flex max-w-md flex-col gap-4 py-8">
        <Stack gap={4}>
          <Title order={3}>Add as a new version</Title>
          <Text size="sm" c="dimmed">
            Pick one of your LoRA models. The checkpoint is added to it as a new draft version, with
            this run&rsquo;s training details, and you review and publish it there.
          </Text>
        </Stack>
        <form method="get" action="/models/train/from-orchestrator">
          {Object.entries(baseQuery).flatMap(([key, value]) =>
            (Array.isArray(value) ? value : value === undefined ? [] : [value]).map((v, i) => (
              <input key={`${key}-${i}`} type="hidden" name={key} value={v} />
            ))
          )}
          <TextInput name="q" defaultValue={query} placeholder="Search your models" />
        </form>
        {models.length ? (
          <Stack gap="xs">
            {models.map((model) => (
              <Anchor
                key={model.id}
                href={pageUrl({ ...baseQuery, modelId: String(model.id) })}
                underline="never"
                className="rounded-md border border-solid border-gray-3 p-3 hover:bg-gray-0 dark:border-dark-4 dark:hover:bg-dark-6"
              >
                <Group justify="space-between" wrap="nowrap">
                  <Text fw={500} lineClamp={1}>
                    {model.name}
                  </Text>
                  {model.latestBaseModel && (
                    <Badge
                      variant="light"
                      color={model.sameBaseModel ? 'gray' : 'yellow'}
                      className="shrink-0"
                    >
                      {model.latestBaseModel}
                    </Badge>
                  )}
                </Group>
                {!model.sameBaseModel && (
                  <Text size="xs" c="yellow">
                    This model&rsquo;s latest version uses a different base model than this run.
                  </Text>
                )}
              </Anchor>
            ))}
          </Stack>
        ) : (
          <Text size="sm" c="dimmed">
            {query
              ? 'None of your LoRA models match that search.'
              : 'You don’t have a LoRA model this run can be added to.'}
          </Text>
        )}
        <Group gap="md">
          <Anchor href={newModelUrl} size="sm">
            Publish as a new model instead
          </Anchor>
          <Anchor href={env.NEXT_PUBLIC_TRAINING_STUDIO_URL} size="sm">
            Back to Training Studio
          </Anchor>
        </Group>
      </div>
    </>
  );
}

function PublishRefused({ refusal }: RefusalProps) {
  return (
    <>
      <Meta title="Can't publish this training run" deIndex />
      <Center h="60vh">
        <Stack align="center" gap="sm" maw={440}>
          <Text ta="center">{refusalMessages[refusal]}</Text>
          <Anchor href={env.NEXT_PUBLIC_TRAINING_STUDIO_URL}>Back to Training Studio</Anchor>
          <Anchor href="/models">Back to models</Anchor>
        </Stack>
      </Center>
    </>
  );
}

/**
 * The epoch was already chosen in Training Studio, so this page performs the wizard's
 * "Select Model File" step unattended — copy the blob into our storage, create the Model file,
 * mark the version Approved, seed the post form with the epoch's samples — and lands the user
 * on "Edit model" for a new model, or "Edit version" for a version added to an existing one (see
 * `wizardUrl`). The manual picker (wizard step 1) stays reachable as the failure fallback.
 */
function PrepareModel({
  target,
  modelId,
  modelVersionId,
  versionName,
  baseModel,
  epochUrl,
  sampleImages,
  existingModelFileId,
}: PrepareProps) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const moveAssetMutation = trpc.training.moveAsset.useMutation();
  const upsertFileMutation = trpc.modelFile.upsert.useMutation();
  const upsertVersionMutation = trpc.modelVersion.upsert.useMutation();
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    (async () => {
      if (sampleImages.length)
        orchestratorMediaTransmitter.setUrls(
          'trainer',
          sampleImages.map((url) => ({ url }))
        );
      const moved = await moveAssetMutation.mutateAsync({ url: epochUrl, modelVersionId });
      await upsertFileMutation.mutateAsync({
        ...(existingModelFileId ? { id: existingModelFileId } : {}),
        url: moved.newUrl,
        name: moved.newUrl.split('/').pop() ?? 'model-file',
        sizeKB: bytesToKB(moved.fileSize ?? 0),
        modelVersionId,
        type: 'Model',
        metadata: { format: getModelFileFormat(moved.newUrl), selectedEpochUrl: epochUrl },
      });
      await upsertVersionMutation.mutateAsync({
        id: modelVersionId,
        modelId,
        name: versionName,
        baseModel: baseModel as BaseModel,
        trainingStatus: TrainingStatus.Approved,
      });
      await router.replace(wizardUrl(target, modelId, modelVersionId, 2));
    })().catch(() => setFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <Meta title="Preparing your model…" deIndex />
      <Center h="60vh">
        {failed ? (
          <Stack align="center" gap="sm" maw={440}>
            <Text ta="center">
              We couldn&rsquo;t prepare the selected checkpoint automatically.
            </Text>
            <Anchor href={wizardUrl(target, modelId, modelVersionId, 1)}>
              Pick the model file manually instead
            </Anchor>
          </Stack>
        ) : (
          <Stack align="center" gap="sm">
            <Loader />
            <Text c="dimmed">Preparing your model…</Text>
          </Stack>
        )}
      </Center>
    </>
  );
}
