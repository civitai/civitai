import { Center, Loader, Stack, Text } from '@mantine/core';
import { TRPCError } from '@trpc/server';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Meta } from '~/components/Meta/Meta';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import { TRAINING_WORKFLOW_TAG } from '~/server/services/orchestrator/training/workflow-state';
import { createDraftModelFromWorkflow } from '~/server/services/orchestrator/training/publish-from-workflow';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { Flags } from '~/shared/utils/flags';
import { OnboardingSteps } from '~/server/common/enums';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    if (!session?.user)
      return {
        redirect: { destination: getLoginLink({ returnUrl: ctx.resolvedUrl }), permanent: false },
      };

    // Mirror `guardedProcedure`: a muted or not-yet-onboarded user can't create a model.
    if (session.user.muted || !Flags.hasFlag(session.user.onboarding, OnboardingSteps.Buzz))
      return { redirect: { destination: '/models', permanent: false } };

    const workflowId = typeof ctx.query.workflowId === 'string' ? ctx.query.workflowId : undefined;
    const epoch = typeof ctx.query.epoch === 'string' ? Number(ctx.query.epoch) : NaN;
    if (!workflowId || !Number.isFinite(epoch))
      return { redirect: { destination: '/models', permanent: false } };

    const token = await getOrchestratorToken(session.user.id, {
      req: ctx.req as unknown as NextApiRequest,
      res: ctx.res as unknown as NextApiResponse,
    });
    // A workflow the caller doesn't own returns NOT_FOUND from the orchestrator — that IS the ownership
    // check, so redirect. A transient upstream fault (503) is NOT "not found" — let it surface as an error
    // page the user can retry, rather than silently bouncing them as if the run doesn't exist.
    let workflow;
    try {
      workflow = await getWorkflow({ token, path: { workflowId } });
    } catch (e) {
      if (e instanceof TRPCError && e.code === 'NOT_FOUND')
        return { redirect: { destination: '/models', permanent: false } };
      throw e;
    }
    if (!workflow || !workflow.tags?.includes(TRAINING_WORKFLOW_TAG))
      return { redirect: { destination: '/models', permanent: false } };

    let modelId: number;
    let modelVersionId: number;
    try {
      ({ modelId, modelVersionId } = await createDraftModelFromWorkflow({
        user: session.user,
        workflow,
        selectedEpochNumber: epoch,
      }));
    } catch {
      // Assemble refuses an unresolvable base / a run with no downloadable checkpoint by throwing — send
      // the user to their models list rather than a 500 page.
      return { redirect: { destination: '/models', permanent: false } };
    }

    return {
      redirect: {
        destination: `/models/${modelId}/model-versions/${modelVersionId}/wizard?step=4`,
        permanent: false,
      },
    };
  },
});

export default function TrainFromOrchestratorPage() {
  return (
    <>
      <Meta title="Preparing your model…" deIndex />
      <Center h="60vh">
        <Stack align="center" gap="sm">
          <Loader />
          <Text c="dimmed">Preparing your model…</Text>
        </Stack>
      </Center>
    </>
  );
}
