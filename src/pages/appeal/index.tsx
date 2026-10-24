import { Anchor, Container, Stack, Text, Title } from '@mantine/core';
import type { InferGetServerSidePropsType } from 'next';
import * as z from 'zod';
import { Meta } from '~/components/Meta/Meta';
import { SiteAppealPanel } from '~/components/SiteAppeal/SiteAppealPanel';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { AppealCategory } from '~/shared/utils/prisma/enums';

// Deep links from a removal notice preselect what is being appealed: `/appeal?category=Model&id=5`.
const querySchema = z.object({
  category: z.enum(AppealCategory).optional().catch(undefined),
  id: z.coerce.number().int().positive().optional().catch(undefined),
});

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.siteAppealForm) return { notFound: true };
    if (!session?.user)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'submit-appeal' }),
          permanent: false,
        },
      };
    return { props: removeEmpty(querySchema.parse(ctx.query)) };
  },
});

export default function AppealPage({
  category,
  id,
}: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <>
      <Meta title="Submit an appeal | Civitai" deIndex />
      <Container size="sm" py="xl">
        <Stack gap="lg">
          <Stack gap="xs">
            <Title order={1}>Appeals</Title>
            <Text>
              If you believe a moderation decision on your account or your content was a mistake,
              tell us here and a moderator will review it. For an image, use the appeal button on
              the image itself.
            </Text>
            <Text size="sm" c="dimmed">
              Can&apos;t sign in to your account? <Anchor href="/support">Contact support</Anchor>.
            </Text>
          </Stack>
          <SiteAppealPanel initialCategory={category} initialEntityId={id} />
        </Stack>
      </Container>
    </>
  );
}
