import {
  Alert,
  Anchor,
  Button,
  Card,
  Code,
  Container,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core';
import { IconCheck, IconExternalLink, IconGitBranch, IconInfoCircle } from '@tabler/icons-react';
import Link from 'next/link';
import { useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * /apps/submit — Civitai-team-only App Block submission form.
 *
 * Creates a Forgejo repo under civitai-apps/<slug> from the starter
 * template, attaches a push webhook, and inserts a pending app_blocks
 * row. The developer then pushes code to the repo; the next push
 * triggers a Tekton build, then an apply Job, and the app is live at
 * <slug>.civit.ai.
 *
 * v0 gate: requires `isModerator`. v1 (W5 + W1) opens to external
 * developers behind the moderator-review queue.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.appBlocks) return { notFound: true };
    if (!session?.user) {
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
    }
    if (!session.user.isModerator) {
      // 404 (rather than 403) so non-team users can't enumerate the surface.
      return { notFound: true };
    }
    return { props: {} };
  },
});

type SubmittedApp = {
  appBlockId: string;
  slug: string;
  repoUrl: string;
  cloneUrl: string;
};

export default function SubmitAppPage() {
  const features = useFeatureFlags();

  // OAuth client picker — every block must be backed by an OauthClient
  // (per app_blocks.app_id FK). v0 lists clients the operator owns;
  // future W5 work narrows this further to a per-team scope.
  const oauthClientsQuery = trpc.oauthClient.getAll.useQuery(undefined, {
    enabled: !!features?.appBlocks,
  });
  const oauthClients = oauthClientsQuery.data ?? [];

  const [slug, setSlug] = useState('');
  const [oauthMode, setOauthMode] = useState<'autoCreate' | 'existing'>('autoCreate');
  const [oauthClientId, setOauthClientId] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [submitted, setSubmitted] = useState<SubmittedApp | null>(null);

  const submitMutation = trpc.blocks.submitApp.useMutation({
    onSuccess: (result) => {
      setSubmitted(result);
    },
    onError: (err) => {
      showErrorNotification({ title: 'Submission failed', error: new Error(err.message) });
    },
  });

  if (!features?.appBlocks) return <NotFound />;

  const slugValid = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(slug);
  const oauthChoiceValid = oauthMode === 'autoCreate' || !!oauthClientId;
  const canSubmit = slugValid && oauthChoiceValid && !submitMutation.isLoading && !submitted;

  return (
    <>
      <Meta title="Submit an App Block — Civitai" deIndex />
      <Container size="sm" py="xl">
        <Stack gap="lg">
          <Stack gap={4}>
            <Title order={2}>Submit a new App Block</Title>
            <Text c="dimmed" size="sm">
              Civitai team only. Creates a new repo in the civitai-apps Forgejo organisation
              from the starter template + wires up auto-deploy. Push to <Code>main</Code> to
              roll out a new version.
            </Text>
          </Stack>

          {submitted ? (
            <SuccessCard app={submitted} />
          ) : (
            <Card withBorder p="lg">
              <Stack gap="md">
                <TextInput
                  label="Slug"
                  description="Used for the repo name, k8s resources, and the public subdomain (<slug>.civit.ai). Lowercase a-z, 0-9, hyphens. 3-40 chars."
                  placeholder="generate-from-model"
                  value={slug}
                  onChange={(e) => setSlug(e.currentTarget.value.toLowerCase())}
                  error={
                    slug.length > 0 && !slugValid
                      ? 'must be lowercase a-z, 0-9, hyphens; start with a letter; end with a letter or digit'
                      : null
                  }
                  required
                  data-autofocus
                />

                <Stack gap={6}>
                  <Text size="sm" fw={500}>
                    OAuth client (app)
                  </Text>
                  <Text size="xs" c="dimmed">
                    Every block is backed by an OauthClient (scope set + allowed origins). Default is to
                    create a fresh public client scoped to this app.
                  </Text>
                  <SegmentedControl
                    value={oauthMode}
                    onChange={(v) => setOauthMode(v as 'autoCreate' | 'existing')}
                    data={[
                      { label: 'Create new', value: 'autoCreate' },
                      {
                        label:
                          oauthClients.length === 0
                            ? 'Use existing (none owned)'
                            : 'Use existing',
                        value: 'existing',
                        disabled: oauthClients.length === 0,
                      },
                    ]}
                  />
                  {oauthMode === 'autoCreate' ? (
                    <Text size="xs" c="dimmed">
                      A new public OauthClient will be created, owned by you, with allowed origin{' '}
                      <Code>https://{slug || '<slug>'}.civit.ai</Code>.
                    </Text>
                  ) : (
                    <Select
                      placeholder={
                        oauthClientsQuery.isLoading ? 'Loading…' : 'Choose an OAuth client'
                      }
                      data={oauthClients.map((c: { id: string; name: string }) => ({
                        value: c.id,
                        label: c.name,
                      }))}
                      value={oauthClientId}
                      onChange={setOauthClientId}
                      searchable
                      nothingFoundMessage="No OAuth clients found"
                    />
                  )}
                </Stack>

                <Textarea
                  label="Description"
                  description="Shown in the Forgejo repo description and on the marketplace card."
                  placeholder="Generate images from this model using the iframe-hosted block"
                  value={description}
                  onChange={(e) => setDescription(e.currentTarget.value)}
                  autosize
                  minRows={2}
                  maxRows={4}
                />

                <Alert
                  icon={<IconInfoCircle size={16} />}
                  color="blue"
                  variant="light"
                  title="What happens next"
                >
                  <Text size="sm" mb={6}>
                    1. We create <Code>civitai-apps/{slug || '<slug>'}</Code> on Forgejo from
                    the starter template.
                  </Text>
                  <Text size="sm" mb={6}>
                    2. We attach a push webhook so every commit to <Code>main</Code> triggers
                    a build via dc-02-a Tekton.
                  </Text>
                  <Text size="sm" mb={6}>
                    3. The first successful build deploys the static bundle at{' '}
                    <Code>{slug ? `${slug}.civit.ai` : '<slug>.civit.ai'}</Code>.
                  </Text>
                  <Text size="sm">
                    4. Update <Code>block.manifest.json</Code> in the new repo to install the
                    block on a model (existing <Code>installOnModel</Code> tRPC flow).
                  </Text>
                </Alert>

                <Group justify="flex-end">
                  <Button
                    variant="default"
                    component={Link}
                    href="/apps/installed"
                    disabled={submitMutation.isLoading}
                  >
                    Cancel
                  </Button>
                  <Button
                    leftSection={<IconGitBranch size={16} />}
                    onClick={() =>
                      submitMutation.mutate({
                        slug,
                        oauthClientId: oauthMode === 'existing' ? oauthClientId! : undefined,
                        description: description.trim() || undefined,
                      })
                    }
                    disabled={!canSubmit}
                    loading={submitMutation.isLoading}
                  >
                    Create repo
                  </Button>
                </Group>
              </Stack>
            </Card>
          )}
        </Stack>
      </Container>
    </>
  );
}

function SuccessCard({ app }: { app: SubmittedApp }) {
  return (
    <Card withBorder p="lg">
      <Stack gap="md">
        <Group gap="xs">
          <IconCheck color="var(--mantine-color-green-6)" size={20} />
          <Title order={4}>Repo created</Title>
        </Group>
        <Text size="sm">
          <Code>civitai-apps/{app.slug}</Code> is ready. Clone it, push your initial commit to{' '}
          <Code>main</Code>, and watch the Forgejo commit-status updates for build + deploy
          progress.
        </Text>
        <Stack gap={4}>
          <Text size="sm" fw={600}>
            Repo
          </Text>
          <Anchor href={app.repoUrl} target="_blank" rel="noopener" size="sm">
            <Group gap={4}>
              <Text component="span">{app.repoUrl}</Text>
              <IconExternalLink size={14} />
            </Group>
          </Anchor>
        </Stack>
        <Stack gap={4}>
          <Text size="sm" fw={600}>
            Clone URL
          </Text>
          <Code block>{`git clone ${app.cloneUrl}`}</Code>
        </Stack>
        <Stack gap={4}>
          <Text size="sm" fw={600}>
            Public URL (live after first successful build)
          </Text>
          <Code block>{`https://${app.slug}.civit.ai/`}</Code>
        </Stack>
        <Stack gap={4}>
          <Text size="sm" fw={600}>
            App Block ID
          </Text>
          <Code block>{app.appBlockId}</Code>
        </Stack>
      </Stack>
    </Card>
  );
}
