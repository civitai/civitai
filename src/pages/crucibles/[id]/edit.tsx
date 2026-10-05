import { Center, Container, Loader } from '@mantine/core';
import type { InferGetServerSidePropsType } from 'next';
import { useRouter } from 'next/router';
import * as z from 'zod';

import { NotFound } from '~/components/AppLayout/NotFound';
import {
  crucibleToFormValues,
  type CrucibleUpdateChanges,
} from '~/components/Crucible/crucible-create-form';
import {
  CrucibleUpsertWizard,
  useCrucibleWizardForm,
  type CrucibleEditTarget,
} from '~/components/Crucible/CrucibleUpsertWizard';
import { Meta } from '~/components/Meta/Meta';
import { dbRead } from '~/server/db/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import { getCrucibleUrl } from '~/utils/crucible-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const querySchema = z.object({ id: z.coerce.number().int().positive() });

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async ({ session, ctx, ssg, features }) => {
    if (!features?.crucible) return { notFound: true };

    const result = querySchema.safeParse(ctx.params);
    if (!result.success) return { notFound: true };
    const { id } = result.data;

    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };

    const crucible = await dbRead.crucible.findUnique({
      where: { id },
      select: { userId: true, status: true, endAt: true },
    });
    if (!crucible) return { notFound: true };

    const isModerator = !!session.user?.isModerator;
    const hasEnded =
      crucible.status === CrucibleStatus.Completed ||
      crucible.status === CrucibleStatus.Cancelled ||
      (!!crucible.endAt && crucible.endAt <= new Date());
    const canEdit =
      isModerator || (crucible.userId === session.user?.id && !hasEnded && !session.user?.muted);
    if (!canEdit) return { redirect: { destination: `/crucibles/${id}`, permanent: false } };

    if (ssg) await ssg.crucible.getById.prefetch({ id });

    return { props: { id } };
  },
});

export default function CrucibleEditPage({
  id,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const { data: crucible, isLoading } = trpc.crucible.getById.useQuery({ id });

  if (isLoading)
    return (
      <Center py="xl">
        <Loader size="xl" />
      </Center>
    );
  if (!crucible) return <NotFound />;

  return (
    <>
      <Meta title={`Edit ${crucible.name}`} deIndex />
      <Container size="lg" py="xl">
        <CrucibleEditForm crucible={crucible} />
      </Container>
    </>
  );
}

function CrucibleEditForm({ crucible }: { crucible: CrucibleEditTarget }) {
  const router = useRouter();
  const queryUtils = trpc.useUtils();
  const form = useCrucibleWizardForm(crucibleToFormValues(crucible));

  const updateMutation = trpc.crucible.update.useMutation({
    onSuccess: async (_, { name }) => {
      await queryUtils.crucible.getById.invalidate({ id: crucible.id });
      showSuccessNotification({ title: 'Crucible updated', message: 'Your changes are live.' });
      router.push(getCrucibleUrl(crucible.id, name ?? crucible.name));
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Could not save your changes',
        error: new Error(error.message),
      });
    },
  });

  return (
    <CrucibleUpsertWizard
      form={form}
      crucible={crucible}
      loading={updateMutation.isPending || updateMutation.isSuccess}
      onSubmit={(changes: CrucibleUpdateChanges) =>
        updateMutation.mutate({ id: crucible.id, ...changes })
      }
    />
  );
}
