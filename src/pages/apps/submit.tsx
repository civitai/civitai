import {
  Alert,
  Anchor,
  Button,
  Card,
  Code,
  Container,
  FileInput,
  Group,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconCloudUpload,
  IconFileZip,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  MAX_BUNDLE_SIZE_BYTES,
  SEMVER_REGEX,
  SLUG_REGEX,
} from '~/server/schema/blocks/publish-request.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * /apps/submit — Submit a new app or a new version of an existing app.
 *
 * The dev uploads a ZIP containing their entire app source tree
 * (Dockerfile + block.manifest.json + index.html + src/...). The
 * platform stores the bundle, computes a diff summary against the
 * previous approved version (if any), and queues a publish request
 * for moderator review at /apps/review.
 *
 * v0 gate: requires `isModerator`. v1 (W11 audit + W5 scopes) opens to
 * external developers.
 *
 * The submission form is intentionally backend-agnostic — devs don't
 * see Forgejo, ghcr.io, Tekton, or any of the deploy substrate. They
 * submit a ZIP and get a status page.
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

type Submitted = {
  publishRequestId: string;
  slug: string;
  version: string;
};

async function fileToBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string | null;
      if (!result) return reject(new Error('FileReader returned empty result'));
      // result format: "data:application/zip;base64,<base64>"
      const idx = result.indexOf(',');
      if (idx < 0) return reject(new Error('FileReader result missing comma'));
      resolve(result.slice(idx + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

export default function SubmitAppPage() {
  const features = useFeatureFlags();
  const [slug, setSlug] = useState('');
  const [version, setVersion] = useState('0.1.0');
  const [bundle, setBundle] = useState<File | null>(null);
  const [encoding, setEncoding] = useState(false);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);

  const submitMutation = trpc.blocks.submitVersion.useMutation({
    onSuccess: (result) => {
      setSubmitted({
        publishRequestId: result.publishRequestId,
        slug: result.slug,
        version: result.version,
      });
    },
    onError: (err) => {
      showErrorNotification({ title: 'Submission failed', error: new Error(err.message) });
    },
  });

  if (!features?.appBlocks) return <NotFound />;

  const slugValid = SLUG_REGEX.test(slug) && slug.length >= 3 && slug.length <= 40;
  const versionValid = SEMVER_REGEX.test(version);
  const bundleValid =
    !!bundle && bundle.size > 0 && bundle.size <= MAX_BUNDLE_SIZE_BYTES;
  const bundleTooLarge = !!bundle && bundle.size > MAX_BUNDLE_SIZE_BYTES;
  const busy = encoding || submitMutation.isLoading || !!submitted;
  const canSubmit = slugValid && versionValid && bundleValid && !busy;

  async function handleSubmit() {
    if (!bundle) return;
    setEncoding(true);
    try {
      const bundleBase64 = await fileToBase64(bundle);
      submitMutation.mutate({ slug, version, bundleBase64 });
    } catch (err) {
      showErrorNotification({
        title: 'Could not read file',
        error: err as Error,
      });
    } finally {
      setEncoding(false);
    }
  }

  return (
    <>
      <Meta title="Submit an app — Civitai" deIndex />
      <Container size="sm" py="xl">
        <Stack gap="lg">
          <Stack gap={4}>
            <Title order={2}>Submit an app</Title>
            <Text c="dimmed" size="sm">
              Upload a ZIP of your app source. A moderator will review the manifest +
              change summary, then approve or reject with feedback. Approved
              submissions deploy automatically to{' '}
              <Code>{slug ? `${slug}.civit.ai` : '<slug>.civit.ai'}</Code>.
            </Text>
          </Stack>

          {submitted ? (
            <SuccessCard submitted={submitted} />
          ) : (
            <Card withBorder p="lg">
              <Stack gap="md">
                <TextInput
                  label="App slug"
                  description="Used as the public subdomain (<slug>.civit.ai) and the install key. Lowercase a-z, 0-9, hyphens. 3-40 chars. Must match block.manifest.json blockId."
                  placeholder="generate-from-model"
                  value={slug}
                  onChange={(e) => setSlug(e.currentTarget.value.toLowerCase().trim())}
                  error={
                    slug.length > 0 && !slugValid
                      ? 'must be lowercase a-z, 0-9, hyphens; start with a letter; end with a letter or digit'
                      : null
                  }
                  required
                  data-autofocus
                />

                <TextInput
                  label="Version"
                  description="Semver. Must match the version in your block.manifest.json. Increment on every submission."
                  placeholder="0.1.0"
                  value={version}
                  onChange={(e) => setVersion(e.currentTarget.value.trim())}
                  error={
                    version.length > 0 && !versionValid
                      ? 'must be semver (e.g. 0.1.0, 1.2.3-beta)'
                      : null
                  }
                  required
                />

                <FileInput
                  label="App bundle (.zip)"
                  description={`ZIP of your app source: Dockerfile + block.manifest.json + index.html + src/. Max ${Math.round(MAX_BUNDLE_SIZE_BYTES / (1024 * 1024))} MiB.`}
                  placeholder="my-app.zip"
                  accept=".zip,application/zip,application/x-zip-compressed"
                  value={bundle}
                  onChange={setBundle}
                  leftSection={<IconFileZip size={16} />}
                  required
                  error={bundleTooLarge ? 'bundle exceeds the size limit' : null}
                />

                <Alert
                  icon={<IconCheck size={16} />}
                  color="blue"
                  variant="light"
                  title="What happens next"
                >
                  <Text size="sm" mb={6}>
                    1. We store your bundle and compute a diff against the previous approved version (if any).
                  </Text>
                  <Text size="sm" mb={6}>
                    2. A moderator reviews the manifest + change summary on{' '}
                    <Code>/apps/review</Code>.
                  </Text>
                  <Text size="sm" mb={6}>
                    3. On approve, the platform deploys your build to{' '}
                    <Code>{slug ? `${slug}.civit.ai` : '<slug>.civit.ai'}</Code> automatically.
                  </Text>
                  <Text size="sm">
                    4. On reject, you'll see the reviewer's feedback inline on{' '}
                    <Anchor component={Link} href="/apps/my-submissions">
                      /apps/my-submissions
                    </Anchor>
                    .
                  </Text>
                </Alert>

                <Group justify="flex-end">
                  <Button
                    variant="default"
                    component={Link}
                    href="/apps/my-submissions"
                    disabled={busy}
                  >
                    Cancel
                  </Button>
                  <Button
                    leftSection={<IconCloudUpload size={16} />}
                    onClick={handleSubmit}
                    disabled={!canSubmit}
                    loading={busy}
                  >
                    Submit for review
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

function SuccessCard({ submitted }: { submitted: Submitted }) {
  return (
    <Card withBorder p="lg">
      <Stack gap="md">
        <Group gap="xs">
          <IconAlertTriangle color="var(--mantine-color-blue-6)" size={20} />
          <Title order={4}>Submitted — pending review</Title>
        </Group>
        <Text size="sm">
          Your submission for <Code>{submitted.slug}</Code> v
          <Code>{submitted.version}</Code> is in the moderator queue. You'll see
          the result on{' '}
          <Anchor component={Link} href="/apps/my-submissions">
            /apps/my-submissions
          </Anchor>{' '}
          when a reviewer approves or rejects.
        </Text>
        <Group>
          <Button component={Link} href="/apps/my-submissions">
            View my submissions
          </Button>
          <Button component={Link} href="/apps/submit" variant="default">
            Submit another
          </Button>
        </Group>
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            Request ID
          </Text>
          <Code block style={{ fontSize: 11 }}>
            {submitted.publishRequestId}
          </Code>
        </Stack>
      </Stack>
    </Card>
  );
}
