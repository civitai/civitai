import {
  Anchor,
  AspectRatio,
  Badge,
  Box,
  Button,
  Card,
  Container,
  Divider,
  Group,
  Loader,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import {
  IconArchive,
  IconArrowLeft,
  IconCube,
  IconPencil,
  IconUpload,
} from '@tabler/icons-react';
import type { InferGetServerSidePropsType } from 'next';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import * as z from 'zod';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { RichTextEditor } from '~/components/RichTextEditor/RichTextEditor';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { Model3DStatus } from '~/shared/utils/prisma/enums';
import { removeEmpty } from '~/utils/object-helpers';
import { parseNumericString } from '~/utils/query-string-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/** Map Model3D status → Mantine color for the header badge. */
const STATUS_COLOR: Record<Model3DStatus, string> = {
  [Model3DStatus.Draft]: 'yellow',
  [Model3DStatus.Published]: 'green',
  [Model3DStatus.Unpublished]: 'orange',
  [Model3DStatus.Deleted]: 'red',
};

const formatSizeMB = (sizeKB: number) => `${(sizeKB / 1024).toFixed(2)} MB`;

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
      // Stay on the edit page. Save only persists name/description — it
      // never changes visibility. The owner uses the Publish action below
      // to release the model.
    },
    onError: (e) => {
      showErrorNotification({ title: 'Save failed', error: new Error(e.message) });
    },
  });

  const publishMutation = trpc.model3d.publish.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        title: 'Published',
        message: 'Your 3D model is now live.',
      });
      utils.model3d.getById.invalidate({ id });
      utils.model3d.getInfinite.invalidate();
    },
    onError: (e) => {
      showErrorNotification({ title: 'Publish failed', error: new Error(e.message) });
    },
  });

  const unpublishMutation = trpc.model3d.unpublish.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        title: 'Unpublished',
        message: 'Your 3D model is back to Draft.',
      });
      utils.model3d.getById.invalidate({ id });
      utils.model3d.getInfinite.invalidate();
    },
    onError: (e) => {
      showErrorNotification({ title: 'Unpublish failed', error: new Error(e.message) });
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

          <Group gap="xs" align="center" wrap="nowrap">
            <IconPencil />
            <Title order={2} className="flex-1">
              Edit 3D Model
            </Title>
            <Badge
              color={STATUS_COLOR[model3d.status] ?? 'gray'}
              variant="light"
              size="lg"
              radius="sm"
            >
              {model3d.status}
            </Badge>
          </Group>

          {/* Read-only summary — thumbnail + files + license + tags. These
              aren't editable yet but the owner needs to see them to make
              sense of what they're naming/describing. */}
          <Card withBorder p="lg">
            <Stack gap="md">
              <Group justify="space-between" align="center">
                <Title order={4}>Generation</Title>
                <Text size="xs" c="dimmed">
                  Read-only — file management lands in a future pass.
                </Text>
              </Group>

              <Group gap="lg" align="flex-start" wrap="nowrap" className="@max-md:flex-col">
                <Box style={{ width: 180, flexShrink: 0 }}>
                  <AspectRatio ratio={1}>
                    {model3d.thumbnailImage ? (
                      <EdgeMedia
                        src={model3d.thumbnailImage.url}
                        type={model3d.thumbnailImage.type}
                        name={model3d.thumbnailImage.name ?? undefined}
                        width={360}
                        anim={false}
                        className="rounded-md object-cover"
                      />
                    ) : (
                      <div className="flex size-full items-center justify-center rounded-md border border-dashed border-gray-4 bg-gray-1 dark:border-dark-4 dark:bg-dark-6">
                        <Stack gap={4} align="center">
                          <IconCube size={28} stroke={1.5} />
                          <Text size="xs" c="dimmed">
                            No thumbnail
                          </Text>
                        </Stack>
                      </div>
                    )}
                  </AspectRatio>
                </Box>

                <Stack gap="md" style={{ flex: 1, minWidth: 0 }}>
                  <div>
                    <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                      Files
                    </Text>
                    {model3d.files.length === 0 ? (
                      <Text size="sm" c="dimmed" mt={4}>
                        No files registered yet.
                      </Text>
                    ) : (
                      <Stack gap={4} mt={4}>
                        {model3d.files.map((f) => (
                          <Group key={f.id} gap="xs" wrap="nowrap">
                            <Badge variant="light" size="sm" radius="sm">
                              {f.format.toUpperCase()}
                            </Badge>
                            {f.isPrimary && (
                              <Badge color="blue" variant="light" size="sm" radius="sm">
                                Primary
                              </Badge>
                            )}
                            <Text size="sm" lineClamp={1} title={f.name}>
                              {f.name}
                            </Text>
                            <Text size="xs" c="dimmed" style={{ marginLeft: 'auto' }}>
                              {formatSizeMB(f.sizeKB)}
                            </Text>
                          </Group>
                        ))}
                      </Stack>
                    )}
                  </div>

                  {model3d.license?.name && (
                    <div>
                      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                        License
                      </Text>
                      <Text size="sm" mt={4}>
                        {model3d.license.name}
                      </Text>
                    </div>
                  )}

                  {model3d.tags && model3d.tags.length > 0 && (
                    <div>
                      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                        Tags
                      </Text>
                      <Group gap={4} mt={4}>
                        {model3d.tags.map((t) => (
                          <Badge key={t.id} variant="outline" size="sm" radius="sm">
                            {t.name}
                          </Badge>
                        ))}
                      </Group>
                    </div>
                  )}
                </Stack>
              </Group>
            </Stack>
          </Card>

          <Card withBorder p="lg">
            <Stack gap="md">
              <Title order={4}>Details</Title>
              <Text size="xs" c="dimmed">
                Set the name and description others will see. Saving here only updates
                these fields — it never changes visibility. Use the Publish action
                below when you&apos;re ready to release.
              </Text>
              <Divider />


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
                  Done
                </Button>
                <Button onClick={handleSave} loading={mutate.isLoading} disabled={!canSave}>
                  Save details
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

          {/* Visibility — Publish / Unpublish are the *only* actions that
              change `Model3D.status`. Saving above never touches it. */}
          <Card withBorder p="lg">
            <Stack gap="md">
              <Group justify="space-between" align="center">
                <Title order={4}>Visibility</Title>
                <Badge
                  color={STATUS_COLOR[model3d.status] ?? 'gray'}
                  variant="light"
                  radius="sm"
                >
                  {model3d.status}
                </Badge>
              </Group>

              {model3d.status === Model3DStatus.Draft && (
                <>
                  <Text size="sm" c="dimmed">
                    This model is a Draft — only you (and moderators) can see it.
                    Publish to make it discoverable in the 3D Models feed.
                    {!model3d.thumbnailImageId && (
                      <>
                        {' '}
                        <Text component="span" c="red">
                          A thumbnail image is required before publishing.
                        </Text>
                      </>
                    )}
                  </Text>
                  <Group justify="flex-end">
                    <Button
                      onClick={() =>
                        openConfirmModal({
                          title: 'Publish 3D Model',
                          children:
                            'Publish this 3D model? It will appear in the 3D Models feed and be downloadable by others.',
                          centered: true,
                          labels: { confirm: 'Publish', cancel: 'Cancel' },
                          confirmProps: { color: 'green' },
                          onConfirm: () => publishMutation.mutate({ id: model3d.id }),
                        })
                      }
                      color="green"
                      leftSection={<IconUpload size={14} />}
                      loading={publishMutation.isLoading}
                      disabled={!model3d.thumbnailImageId || trimmedName.length === 0}
                    >
                      Publish
                    </Button>
                  </Group>
                </>
              )}

              {model3d.status === Model3DStatus.Published && (
                <>
                  <Text size="sm" c="dimmed">
                    This model is live in the 3D Models feed. Unpublish to take it
                    back to Draft (it will no longer be visible to others).
                  </Text>
                  <Group justify="flex-end">
                    <Button
                      onClick={() =>
                        openConfirmModal({
                          title: 'Unpublish 3D Model',
                          children:
                            'Unpublish this 3D model? It will move back to Draft and be hidden from others until you republish.',
                          centered: true,
                          labels: { confirm: 'Unpublish', cancel: 'Cancel' },
                          confirmProps: { color: 'yellow' },
                          onConfirm: () => unpublishMutation.mutate({ id: model3d.id }),
                        })
                      }
                      color="yellow"
                      leftSection={<IconArchive size={14} />}
                      loading={unpublishMutation.isLoading}
                    >
                      Unpublish
                    </Button>
                  </Group>
                </>
              )}

              {model3d.status === Model3DStatus.Unpublished && (
                <>
                  <Text size="sm" c="dimmed">
                    This model was unpublished. You can republish it at any time.
                  </Text>
                  <Group justify="flex-end">
                    <Button
                      onClick={() =>
                        openConfirmModal({
                          title: 'Republish 3D Model',
                          children:
                            'Republish this 3D model? It will appear in the 3D Models feed again.',
                          centered: true,
                          labels: { confirm: 'Republish', cancel: 'Cancel' },
                          confirmProps: { color: 'green' },
                          onConfirm: () => publishMutation.mutate({ id: model3d.id }),
                        })
                      }
                      color="green"
                      leftSection={<IconUpload size={14} />}
                      loading={publishMutation.isLoading}
                      disabled={!model3d.thumbnailImageId || trimmedName.length === 0}
                    >
                      Republish
                    </Button>
                  </Group>
                </>
              )}

              {model3d.status === Model3DStatus.Deleted && (
                <Text size="sm" c="dimmed">
                  This model is deleted. Restore it from the moderator tools to manage
                  visibility again.
                </Text>
              )}
            </Stack>
          </Card>
        </Stack>
      </Container>
    </>
  );
}

export default Page(Model3DEditPage);
