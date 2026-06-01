import {
  Anchor,
  Button,
  Card,
  Container,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconArrowLeft, IconPencil } from '@tabler/icons-react';
import type { InferGetServerSidePropsType } from 'next';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import * as z from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { RichTextEditor } from '~/components/RichTextEditor/RichTextEditor';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { parseNumericString } from '~/utils/query-string-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * /3d-models/[id]/edit — owner/mod editor for a Model3D.
 *
 * v1 surface only edits name + description. The page is here (rather than a
 * modal) so future passes can grow it without uprooting consumers:
 *   - file management (add / remove / replace formats)
 *   - thumbnail replacement
 *   - license + tag picker
 *   - NSFW level / availability / locked properties
 *
 * Flag + ownership gating lives in `getServerSideProps`; the ownership check
 * uses the row's userId so a server-side 404 covers both "model not found"
 * and "not yours" without leaking existence.
 */

const querySchema = z.object({
  id: z.preprocess(parseNumericString, z.number()),
});

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ ctx, features, session }) => {
    if (!features?.model3dFeed) return { notFound: true };
    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };
    if (!session?.user) {
      return {
        redirect: {
          destination: `/login?returnUrl=${encodeURIComponent(`/3d-models/${result.data.id}/edit`)}`,
          permanent: false,
        },
      };
    }
    return { props: removeEmpty(result.data) };
  },
});

function Model3DEditPage({ id }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();

  const { data: model3d, isLoading } = trpc.model3d.getById.useQuery({ id });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // Seed local state once the query lands. We don't reset on subsequent
  // refetches so an in-progress edit isn't clobbered by a background refresh.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!seeded && model3d) {
      setName(model3d.name);
      setDescription(model3d.description ?? '');
      setSeeded(true);
    }
  }, [seeded, model3d]);

  const mutate = trpc.model3d.upsert.useMutation({
    onSuccess: () => {
      showSuccessNotification({ title: 'Saved', message: 'Model details updated.' });
      utils.model3d.getById.invalidate({ id });
      utils.model3d.getInfinite.invalidate();
      router.push(`/3d-models/${id}`);
    },
    onError: (e) => {
      showErrorNotification({ title: 'Save failed', error: new Error(e.message) });
    },
  });

  if (isLoading) return <PageLoader />;
  if (!model3d) return <NotFound />;

  const isOwner = !!currentUser && currentUser.id === model3d.userId;
  const isModerator = !!currentUser?.isModerator;
  if (!isOwner && !isModerator) return <NotFound />;

  const trimmedName = name.trim();
  const canSave = trimmedName.length > 0 && !mutate.isLoading;

  // RichTextEditor returns HTML. Empty content commonly serializes to `<p></p>`
  // — strip tags and treat as null so the DB doesn't see noisy "empty" markup.
  const normalizeDescription = (html: string): string | null => {
    const stripped = html.replace(/<[^>]*>/g, '').trim();
    return stripped.length === 0 ? null : html.trim();
  };

  const handleSave = () => {
    if (!canSave) return;
    mutate.mutate({
      id: model3d.id,
      name: trimmedName,
      description: normalizeDescription(description),
      // Pass through existing licenseId — the upsert schema requires it but
      // editing name/description here shouldn't change licensing.
      licenseId: model3d.licenseId,
    });
  };

  return (
    <>
      <Meta title={`Edit · ${model3d.name} | 3D Models | Civitai`} deIndex />
      <Container size="md" py="lg">
        <Stack gap="md">
          <Anchor
            component={Link}
            href={`/3d-models/${id}`}
            size="sm"
            className="flex items-center gap-1"
          >
            <IconArrowLeft size={14} /> Back to model
          </Anchor>

          <Group gap="xs" align="center">
            <IconPencil />
            <Title order={2}>Edit 3D Model</Title>
          </Group>

          <Card withBorder p="lg">
            <Stack gap="md">
              <Text size="xs" c="dimmed">
                Editing name and description. File management, license / tag editing, and
                NSFW controls will land here in future passes.
              </Text>

              <TextInput
                label="Name"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                maxLength={150}
                required
                autoFocus
                error={trimmedName.length === 0 ? 'Name cannot be empty' : undefined}
              />

              <RichTextEditor
                label="Description"
                placeholder="What's this model about? How was it generated? Any tips?"
                value={description}
                onChange={(value) => setDescription(value ?? '')}
                includeControls={[
                  'heading',
                  'formatting',
                  'list',
                  'link',
                  'media',
                  'colors',
                ]}
                editorSize="xl"
                stickyToolbar
              />

              <Group justify="flex-end" gap="sm">
                <Button
                  variant="default"
                  component={Link}
                  href={`/3d-models/${id}`}
                  disabled={mutate.isLoading}
                >
                  Cancel
                </Button>
                <Button onClick={handleSave} loading={mutate.isLoading} disabled={!canSave}>
                  Save changes
                </Button>
              </Group>

              {mutate.isLoading && (
                <Group gap="xs" justify="center">
                  <Loader size="xs" />
                  <Text size="xs" c="dimmed">
                    Saving…
                  </Text>
                </Group>
              )}
            </Stack>
          </Card>
        </Stack>
      </Container>
    </>
  );
}

export default Page(Model3DEditPage);
