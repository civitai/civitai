import { Anchor, Center, Loader, Stack, Text } from '@mantine/core';
import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import { TRAINING_WORKFLOW_TAG } from '~/server/services/orchestrator/training/workflow-state';
import type { PublishRefusalReason } from '~/server/services/orchestrator/training/publish-from-workflow';
import {
  createDraftModelFromWorkflow,
  getPublishRefusalReason,
  stampWorkflowDraftModel,
} from '~/server/services/orchestrator/training/publish-from-workflow';
import { env } from '~/env/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { dbWrite } from '~/server/db/client';
import { getLoginLink } from '~/utils/login-helpers';
import { Flags } from '~/shared/utils/flags';
import { OnboardingSteps } from '~/server/common/enums';
import { getConsumerBlobId } from '~/shared/orchestrator/blob-url';
import type { BaseModel } from '~/shared/constants/basemodel.constants';
import type { Session } from '~/types/session';
import { TrainingStatus } from '~/shared/utils/prisma/enums';
import { orchestratorMediaTransmitter } from '~/store/post-image-transmitter.store';
import { getModelFileFormat } from '~/utils/file-helpers';
import { bytesToKB } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

// The MODEL wizard, not the model-version wizard: for trained uploads its steps are
// Select File → Edit model → Edit version → Post, and "Edit model" (title, description, tags)
// exists nowhere else — studio-born drafts are synthesized, so the user has never seen it.
const wizardUrl = (modelId: number, modelVersionId: number, step: number) =>
  `/models/${modelId}/wizard?step=${step}&modelVersionId=${modelVersionId}`;

type PrepareProps = {
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

type PageProps = { session: Session } & (PrepareProps | RefusalProps);

export const getServerSideProps = createServerSideProps<PageProps>({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    if (!session?.user)
      return {
        redirect: { destination: getLoginLink({ returnUrl: ctx.resolvedUrl }), permanent: false },
      };

    // Mirror `guardedProcedure`: a banned, muted or not-yet-onboarded user can't create a model.
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

    const token = await getOrchestratorToken(session.user.id, {
      req: ctx.req as unknown as NextApiRequest,
      res: ctx.res as unknown as NextApiResponse,
    });
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

    let modelId: number;
    let modelVersionId: number;
    let selectedEpoch: Awaited<ReturnType<typeof createDraftModelFromWorkflow>>['selectedEpoch'];
    try {
      ({ modelId, modelVersionId, selectedEpoch } = await createDraftModelFromWorkflow({
        user: session.user,
        workflow,
        selectedEpochNumber: epoch,
      }));
    } catch (error) {
      return refuse(getPublishRefusalReason(error) ?? 'unavailable');
    }

    await stampWorkflowDraftModel({ token, workflow, modelId, modelVersionId });

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
          destination: wizardUrl(modelId, modelVersionId, existingModelFile ? 2 : 1),
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
        redirect: { destination: wizardUrl(modelId, modelVersionId, 2), permanent: false },
      };

    return {
      props: {
        session,
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

export default function TrainFromOrchestratorPage(props: PrepareProps | RefusalProps) {
  if ('refusal' in props) return <PublishRefused refusal={props.refusal} />;
  return <PrepareModel {...props} />;
}

const refusalMessages: Record<Refusal, string> = {
  'not-approved':
    'This training run’s dataset hasn’t been approved, so a model can’t be created from it. If the dataset is still being reviewed, try again once the review is complete.',
  'unsupported-base':
    'Models trained on this base model can’t be published as a model page yet. Your run and its checkpoints are still available in Training Studio.',
  'no-checkpoint':
    'This training run has no checkpoint left to publish. Checkpoints are only kept for a limited time after training finishes.',
  'not-found': 'We couldn’t find this training run on your account.',
  unavailable: 'We couldn’t create a model page from this training run. Please try again later.',
};

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
 * on "Edit model". The manual picker (wizard step 1) stays reachable as the failure fallback.
 */
function PrepareModel({
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
      await router.replace(wizardUrl(modelId, modelVersionId, 2));
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
            <Anchor href={wizardUrl(modelId, modelVersionId, 1)}>
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
