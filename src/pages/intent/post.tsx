import { Alert, Code, Container, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useEffect, useMemo, useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import type { CheckedIntentMedia } from '~/components/Post/Intent/check-intent-media';
import { checkIntentMedia } from '~/components/Post/Intent/check-intent-media';
import type { IntentComposeValues } from '~/components/Post/Intent/IntentComposeSheet';
import { IntentComposeSheet } from '~/components/Post/Intent/IntentComposeSheet';
import { useShowCreatePostError } from '~/components/Post/showCreatePostError';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import type { OpenIntentQuery } from '~/shared/utils/post-intent';
import {
  appendSourceLink,
  openIntentQuerySchema,
  resolveIntentMode,
  withPostedParam,
} from '~/shared/utils/post-intent';
import {
  orchestratorMediaTransmitter,
  useExternalMetaStore,
} from '~/store/post-image-transmitter.store';
import { getLoginLink } from '~/utils/login-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const TRANSMITTER_KEY = 'post-intent';

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ session, ctx }) => {
    if (!session) {
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'perform-action' }),
          permanent: false,
        },
      };
    }
    if (session.user?.muted) return { notFound: true };
  },
});

function IntentShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Meta title="Create a Post | Civitai" deIndex={true} />
      {children}
    </>
  );
}

function IntentMessage({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <Container size="xs" px="md" my="lg">
      <Stack>
        <Title order={2}>Create a post</Title>
        <Alert color="red" icon={<IconAlertCircle size={16} />} title={title}>
          {children}
        </Alert>
      </Stack>
    </Container>
  );
}

function IntentLoading({ label }: { label: string }) {
  return (
    <Container size="xs" px="md" my="xl">
      <Group justify="center" gap="sm">
        <Loader size="sm" />
        <Text c="dimmed">{label}</Text>
      </Group>
    </Container>
  );
}

function AppIntent({ manifestUrl }: { manifestUrl: string }) {
  const router = useRouter();
  const stage = trpc.postIntent.stage.useMutation();
  const publish = trpc.postIntent.publish.useMutation();
  const [values, setValues] = useState<IntentComposeValues>({
    title: '',
    description: '',
    tags: [],
  });
  const [busy, setBusy] = useState<'primary' | 'editor'>();

  useEffect(() => {
    stage.mutate(
      { manifestUrl },
      {
        onSuccess: (data) =>
          setValues({
            title: data.title ?? '',
            description: data.description ?? '',
            tags: data.tags,
          }),
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifestUrl]);

  const submit = (asPublished: boolean) => {
    setBusy(asPublished ? 'primary' : 'editor');
    publish.mutate(
      {
        manifestUrl,
        title: values.title || null,
        description: values.description || null,
        tags: values.tags,
        publish: asPublished,
      },
      {
        onSuccess: async ({ postId, returnUrl }) => {
          if (!asPublished) return router.replace(`/posts/${postId}/edit`);
          showSuccessNotification({ title: 'Posted!', message: 'Your post is live on Civitai.' });
          if (returnUrl) window.location.assign(withPostedParam(returnUrl, postId));
          else await router.replace(`/posts/${postId}`);
        },
        onSettled: (_data, error) => {
          if (error) setBusy(undefined);
        },
      }
    );
  };

  if (stage.error)
    return <IntentMessage title="We couldn't open this share">{stage.error.message}</IntentMessage>;
  if (!stage.data) return <IntentLoading label="Getting your post ready..." />;

  return (
    <IntentComposeSheet
      media={stage.data.media}
      values={values}
      onChange={setValues}
      appName={stage.data.app.name}
      primaryLabel="Publish"
      onPrimary={() => submit(true)}
      onOpenEditor={() => submit(false)}
      busy={busy}
      error={publish.error?.message}
    />
  );
}

function OpenIntent({ query }: { query: OpenIntentQuery }) {
  const router = useRouter();
  const queryUtils = trpc.useUtils();
  const showCreatePostError = useShowCreatePostError();
  const createPost = trpc.post.create.useMutation();
  const [media, setMedia] = useState<CheckedIntentMedia[]>();
  const [mediaError, setMediaError] = useState<string>();
  const [values, setValues] = useState<IntentComposeValues>({
    title: query.title ?? '',
    description: query.description ?? '',
    tags: query.tags ?? [],
  });
  const [busy, setBusy] = useState<'primary'>();

  useEffect(() => {
    Promise.all(query.mediaUrls.map((url) => checkIntentMedia(url)))
      .then(setMedia)
      .catch((e: Error) => setMediaError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const proceed = () => {
    if (!media) return;
    setBusy('primary');
    createPost.mutate(
      {
        title: values.title || undefined,
        detail: appendSourceLink(values.description || undefined, query.link),
        tags: values.tags,
      },
      {
        onSuccess: async (res) => {
          queryUtils.post.getEdit.setData({ id: res.id }, () => res);
          orchestratorMediaTransmitter.setUrls(
            TRANSMITTER_KEY,
            media.map(({ url }) => ({ url }))
          );
          if (query.detailsUrl) useExternalMetaStore.getState().setUrl(query.detailsUrl);
          showSuccessNotification({
            title: 'Success!',
            message: "Please check the data and publish the post when you're ready.",
            autoClose: 10000,
          });
          await router.replace(
            { pathname: `/posts/${res.id}/edit`, query: { src: TRANSMITTER_KEY } },
            undefined,
            { shallow: true }
          );
        },
        onError(error) {
          showCreatePostError(error.message);
          setBusy(undefined);
        },
      }
    );
  };

  if (mediaError)
    return <IntentMessage title="We couldn't use that media">{mediaError}</IntentMessage>;
  if (!media) return <IntentLoading label="Checking media..." />;

  return (
    <IntentComposeSheet
      media={media}
      values={values}
      onChange={setValues}
      sourceLink={query.link}
      primaryLabel="Continue"
      onPrimary={proceed}
      busy={busy}
    />
  );
}

export default function IntentPost() {
  const router = useRouter();
  const features = useFeatureFlags();
  const mode = useMemo(
    () => resolveIntentMode(router.query, !!features.appPostIntent),
    [router.query, features.appPostIntent]
  );
  const openQuery = useMemo(() => openIntentQuerySchema.safeParse(router.query), [router.query]);

  if (!router.isReady) return <IntentShell>{null}</IntentShell>;
  if (mode.mode === 'app')
    return (
      <IntentShell>
        <AppIntent manifestUrl={mode.manifestUrl} />
      </IntentShell>
    );
  if (!openQuery.success)
    return (
      <IntentShell>
        <IntentMessage title="This link is missing something">
          <Stack gap={4}>
            {openQuery.error.issues.map((issue, idx) => (
              <Group key={idx} gap="xs" wrap="nowrap">
                <Code>{issue.path.join('.') || 'link'}</Code>
                <Text size="sm">{issue.message}</Text>
              </Group>
            ))}
          </Stack>
        </IntentMessage>
      </IntentShell>
    );
  return (
    <IntentShell>
      <OpenIntent query={openQuery.data} />
    </IntentShell>
  );
}
