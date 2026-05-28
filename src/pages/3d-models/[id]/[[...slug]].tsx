import {
  Anchor,
  Box,
  Button,
  Card,
  Container,
  Divider,
  Group,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconCube, IconMessage, IconStar } from '@tabler/icons-react';
import type { InferGetServerSidePropsType } from 'next';
import * as z from 'zod';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { parseNumericString } from '~/utils/query-string-helpers';
import { removeEmpty } from '~/utils/object-helpers';

/**
 * Model3D detail page (Workstream D stub).
 *
 * Stub sections for description, files dropdown, comments, makes/uses, and a
 * link to the reviews page. Workstream G replaces this with the real
 * implementation backed by the `model3d.getById` tRPC query and wires the
 * `<Model3DViewer>` component (dynamic-imported, ssr:false) in place of the
 * "Viewer goes here" panel below.
 */

const querySchema = z.object({
  id: z.preprocess(parseNumericString, z.number()),
  slug: z.array(z.string()).optional(),
});

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ ctx }) => {
    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };
    return { props: removeEmpty(result.data) };
  },
});

function Model3DDetailsPage({ id }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  return (
    <>
      <Meta
        title={`3D Model #${id} | Civitai`}
        description="3D model detail page (under construction)."
        canonical={`/3d-models/${id}`}
        deIndex
      />
      <Container size="xl" pos="relative">
        <Stack gap="md">
          <Group justify="space-between" wrap="nowrap">
            <Title order={1}>3D Model #{id}</Title>
            <Button
              component={Link}
              href={`/3d-models/${id}/reviews`}
              variant="light"
              leftSection={<IconStar size={16} />}
            >
              Reviews
            </Button>
          </Group>

          {/*
            Stub viewer slot. When Workstream G wires up the `model3d.getById`
            query, replace the inline panel below with:
              <Model3DViewer url={primaryFile.url} format={primaryFile.format} sizeKB={primaryFile.sizeKB} />
            The `Model3DViewer` is dynamic-imported above with `ssr:false`.
          */}
          <Card withBorder radius="md" p={0} className="overflow-hidden">
            <Box className="flex min-h-[420px] items-center justify-center bg-dark-7 p-6">
              <Stack align="center" gap="xs" maw={420} ta="center">
                <IconCube size={48} stroke={1.5} />
                <Text fw={600}>Viewer goes here</Text>
                <Text size="sm" c="dimmed">
                  Workstream G wires the primary file URL + format from the Model3D query into the{' '}
                  <code>Model3DViewer</code> component.
                </Text>
              </Stack>
            </Box>
          </Card>

          <Card withBorder radius="md" p="md">
            <Stack gap="xs">
              <Title order={3}>Description</Title>
              <Text c="dimmed" size="sm">
                Model description, tags, license, and creator metadata will render here.
              </Text>
            </Stack>
          </Card>

          <Card withBorder radius="md" p="md">
            <Stack gap="xs">
              <Title order={3}>Files</Title>
              <Text c="dimmed" size="sm">
                Format dropdown (GLB / FBX / OBJ / …) with download CTA will render here.
              </Text>
            </Stack>
          </Card>

          <Card withBorder radius="md" p="md">
            <Stack gap="xs">
              <Title order={3}>Makes &amp; Uses</Title>
              <Text c="dimmed" size="sm">
                Community Posts linked via <code>Post.model3dId</code> will render here.
              </Text>
            </Stack>
          </Card>

          <Divider />

          <Card withBorder radius="md" p="md" id="comments">
            <Stack gap="xs">
              <Group gap="xs">
                <IconMessage size={20} />
                <Title order={3}>Comments</Title>
              </Group>
              <Text c="dimmed" size="sm">
                Comment thread will render here (Workstream G).
              </Text>
            </Stack>
          </Card>

          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              Reviews live on a dedicated page.
            </Text>
            <Anchor component={Link} href={`/3d-models/${id}/reviews`}>
              View reviews →
            </Anchor>
          </Group>
        </Stack>
      </Container>
    </>
  );
}

export default Page(Model3DDetailsPage);
