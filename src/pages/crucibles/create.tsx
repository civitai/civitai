import { Container } from '@mantine/core';
import { useRouter } from 'next/router';

import { submissionIntent, withPaymentIntentKey } from '~/components/Buzz/payment-intent-keys';
import { ChallengeCreateRequirements } from '~/components/Challenge/ChallengeCreateRequirements';
import {
  CRUCIBLE_CREATE_DRAFT_KEY,
  crucibleCreateDefaultValues,
  crucibleCreateDraftSchema,
  toCrucibleSubmitValues,
  type CrucibleCreateFormValues,
} from '~/components/Crucible/crucible-create-form';
import {
  CrucibleUpsertWizard,
  useCrucibleWizardForm,
} from '~/components/Crucible/CrucibleUpsertWizard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFormStorage } from '~/hooks/useFormStorage';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx, features }) => {
    if (!features?.crucible) return { notFound: true };

    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'create-crucible' }),
          permanent: false,
        },
      };
    if (session.user?.muted) return { notFound: true };
  },
});

export default function CrucibleCreate() {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const form = useCrucibleWizardForm(crucibleCreateDefaultValues);

  const { data: createEligibility } = trpc.crucible.getCreateEligibility.useQuery(undefined, {
    enabled: !!currentUser && !currentUser.isModerator,
  });

  const clearDraft = useFormStorage({
    schema: crucibleCreateDraftSchema,
    form,
    timeout: 1000,
    key: CRUCIBLE_CREATE_DRAFT_KEY,
    watch: (value) => value,
  });

  const createCrucibleMutation = trpc.crucible.create.useMutation({
    onSuccess: (data) => {
      clearDraft();
      showSuccessNotification({
        title: 'Crucible Created!',
        message: 'Your crucible has been created successfully. Redirecting...',
      });
      router.push(`/crucibles/${data.id}`);
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to create crucible',
        error: { message: error.message },
      });
    },
  });

  const handleSubmit = (values: CrucibleCreateFormValues) => {
    const { coverImage, ...input } = toCrucibleSubmitValues(values);
    if (!coverImage) {
      showErrorNotification({
        title: 'Missing Cover Image',
        error: { message: 'Please upload a cover image for your crucible.' },
      });
      return;
    }
    const payload = { ...input, coverImage };
    // One key per creation (its content), held across a failure that may have charged the setup
    // fee or the seed, so creating it again is the same crucible, charged once. The mutation's
    // onError reports a failure.
    withPaymentIntentKey(submissionIntent('crucible-create', payload), (idempotencyKey) =>
      createCrucibleMutation.mutateAsync({ ...payload, idempotencyKey })
    ).catch(() => undefined);
  };

  return (
    <Container size="lg" py="xl">
      {createEligibility && !createEligibility.canCreate && (
        <ChallengeCreateRequirements
          eligibility={createEligibility}
          noun="crucible"
          backUrl="/crucibles"
        />
      )}
      <CrucibleUpsertWizard
        form={form}
        loading={createCrucibleMutation.isPending || createCrucibleMutation.isSuccess}
        onSubmit={handleSubmit}
      />
    </Container>
  );
}
