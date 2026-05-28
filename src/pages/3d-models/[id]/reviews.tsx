import { Anchor, Card, Center, Container, Stack, Text, Title } from '@mantine/core';
import { IconStar } from '@tabler/icons-react';
import type { InferGetServerSidePropsType } from 'next';
import * as z from 'zod';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { parseNumericString } from '~/utils/query-string-helpers';
import { removeEmpty } from '~/utils/object-helpers';

/**
 * Model3D reviews page (Workstream D stub).
 *
 * The full reviews list + write-review modal entry-point lives behind
 * Workstream G. This stub keeps the route resolvable so links from the detail
 * page don't 404.
 */

const querySchema = z.object({
  id: z.preprocess(parseNumericString, z.number()),
});

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ ctx }) => {
    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };
    return { props: removeEmpty(result.data) };
  },
});

function Model3DReviewsPage({ id }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <>
      <Meta
        title={`Reviews · 3D Model #${id} | Civitai`}
        description="Reviews for this 3D model (under construction)."
        canonical={`/3d-models/${id}/reviews`}
        deIndex
      />
      <Container size="md">
        <Stack gap="md">
          <Stack gap={4}>
            <Title order={1}>Reviews</Title>
            <Anchor component={Link} href={`/3d-models/${id}`} size="sm">
              ← Back to 3D Model #{id}
            </Anchor>
          </Stack>
          <Card withBorder radius="md" p="xl">
            <Center>
              <Stack align="center" gap="sm" maw={420} ta="center">
                <IconStar size={48} stroke={1.5} />
                <Title order={3}>Reviews coming soon</Title>
                <Text c="dimmed" size="sm">
                  The reviews list and write-a-review modal are being wired up. Check back shortly.
                </Text>
              </Stack>
            </Center>
          </Card>
        </Stack>
      </Container>
    </>
  );
}

export default Page(Model3DReviewsPage);
