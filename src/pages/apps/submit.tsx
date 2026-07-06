import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Code,
  FileInput,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconCloudUpload,
  IconFileZip,
  IconRefresh,
} from '@tabler/icons-react';
import JSZip from 'jszip';
import Link from 'next/link';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { CliSubmitCta } from '~/components/Apps/CliSubmitCta';
import { ExternalSubmitForm } from '~/components/Apps/ExternalSubmitForm';
import { ManualUploadSection } from '~/components/Apps/ManualUploadSection';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  MAX_BUNDLE_SIZE_BYTES,
  SEMVER_REGEX,
  SLUG_REGEX,
} from '~/server/schema/blocks/publish-request.schema';
import { isAppDeveloper } from '~/shared/utils/app-blocks-access';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * /apps/submit — Submit a new app or a new version of an existing app.
 *
 * The dev picks a ZIP of their app source. The form parses
 * block.manifest.json client-side, shows the slug + version + name +
 * targets the manifest will register, and only then enables Submit.
 * No separate slug/version fields — the manifest is the source of
 * truth, and a typed slug that doesn't match would be a typo trap.
 *
 * v0 gate: requires `isModerator`.
 */
export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    // Author-capability gate (Phase B): the dedicated `appBlocksAuthor` flag
    // (Flipt `app-blocks-author`, static fallback mod-only), INDEPENDENT of the
    // marketplace-visibility `appBlocks` flag (which widens to public at GA).
    if (!features?.appBlocksAuthor) return { notFound: true };
    if (!session?.user) {
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
    }
    if (!isAppDeveloper(session.user, { appBlocksAuthor: features?.appBlocksAuthor })) {
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

type ParsedManifest = {
  blockId: string;
  version: string;
  name: string;
  description?: string;
  contentRating?: string;
  targets?: Array<{ slotId?: string; priority?: number }>;
};

type ManifestPreview = { ok: true; manifest: ParsedManifest } | { ok: false; error: string };

async function fileToBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string | null;
      if (!result) return reject(new Error('FileReader returned empty result'));
      const idx = result.indexOf(',');
      if (idx < 0) return reject(new Error('FileReader result missing comma'));
      resolve(result.slice(idx + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * Parse the ZIP client-side and pull out block.manifest.json so the
 * dev sees what they're about to submit. Same shape checks as the
 * server-side submitVersion does — kept in sync so failures surface
 * before the upload round-trip.
 */
async function previewManifest(file: File): Promise<ManifestPreview> {
  if (file.size === 0) return { ok: false, error: 'file is empty' };
  if (file.size > MAX_BUNDLE_SIZE_BYTES) {
    return {
      ok: false,
      error: `bundle is ${Math.round(file.size / (1024 * 1024))} MiB — max ${Math.round(
        MAX_BUNDLE_SIZE_BYTES / (1024 * 1024)
      )} MiB`,
    };
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch (err) {
    return { ok: false, error: `could not read file: ${(err as Error).message}` };
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err) {
    return { ok: false, error: `not a valid ZIP: ${(err as Error).message}` };
  }
  const manifestEntry = zip.file('block.manifest.json');
  if (!manifestEntry) {
    return { ok: false, error: 'block.manifest.json missing from bundle root' };
  }
  let raw: string;
  try {
    raw = await manifestEntry.async('text');
  } catch (err) {
    return { ok: false, error: `could not read manifest: ${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `manifest is not valid JSON: ${(err as Error).message}` };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'manifest must be a JSON object' };
  }
  const m = parsed as Record<string, unknown>;
  if (
    typeof m.blockId !== 'string' ||
    !SLUG_REGEX.test(m.blockId) ||
    m.blockId.length < 3 ||
    m.blockId.length > 40
  ) {
    return {
      ok: false,
      error: `manifest.blockId "${
        m.blockId ?? ''
      }" must be 3-40 chars, lowercase a-z/0-9/hyphens, start with a letter`,
    };
  }
  if (typeof m.version !== 'string' || !SEMVER_REGEX.test(m.version)) {
    return {
      ok: false,
      error: `manifest.version "${m.version ?? ''}" must be semver (e.g. 0.1.0)`,
    };
  }
  if (typeof m.name !== 'string' || m.name.length === 0) {
    return { ok: false, error: 'manifest.name must be a non-empty string' };
  }
  return {
    ok: true,
    manifest: {
      blockId: m.blockId,
      version: m.version,
      name: m.name,
      description: typeof m.description === 'string' ? m.description : undefined,
      contentRating: typeof m.contentRating === 'string' ? m.contentRating : undefined,
      targets: Array.isArray(m.targets)
        ? (m.targets as Array<{ slotId?: string; priority?: number }>)
        : undefined,
    },
  };
}

type SubmitMode = 'block' | 'external';

export default function SubmitAppPage() {
  const features = useFeatureFlags();
  const [mode, setMode] = useState<SubmitMode>('block');
  const [bundle, setBundle] = useState<File | null>(null);
  const [preview, setPreview] = useState<ManifestPreview | null>(null);
  const [encoding, setEncoding] = useState(false);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!bundle) {
      setPreview(null);
      return;
    }
    setPreview(null); // clear stale preview while parsing
    previewManifest(bundle).then((p) => {
      if (!cancelled) setPreview(p);
    });
    return () => {
      cancelled = true;
    };
  }, [bundle]);

  // Pre-flight: once the manifest's slug is known, check whether the
  // current user already has a pending submission for it. Surfacing this
  // inline lets us turn "submit → server error → toast" into a clear
  // "withdraw and resubmit" affordance.
  const previewedSlug = preview?.ok ? preview.manifest.blockId : null;
  const pendingQuery = trpc.blocks.getMyPendingForSlug.useQuery(
    { slug: previewedSlug ?? '' },
    { enabled: !!previewedSlug, staleTime: 0 }
  );
  const existingPending = pendingQuery.data?.pending ?? null;

  // The bundle upload goes to the dedicated /api/blocks/submit-version route
  // (72mb body limit) rather than tRPC, so the shared tRPC route stays at
  // 17mb. The route is moderator-gated + appBlocks-flag-gated server-side.
  const submitMutation = useMutation({
    mutationFn: async (input: { bundleBase64: string }) => {
      const res = await fetch('/api/blocks/submit-version', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = (await res.json().catch(() => ({}))) as {
        publishRequestId?: string;
        slug?: string;
        version?: string;
        message?: string;
      };
      if (!res.ok || !data.publishRequestId || !data.slug || !data.version) {
        throw new Error(data.message ?? `Submission failed (${res.status})`);
      }
      return { publishRequestId: data.publishRequestId, slug: data.slug, version: data.version };
    },
    onSuccess: (result) => {
      setSubmitted({
        publishRequestId: result.publishRequestId,
        slug: result.slug,
        version: result.version,
      });
    },
    onError: (err) => {
      showErrorNotification({ title: 'Submission failed', error: err as Error });
    },
  });

  const withdrawMutation = trpc.blocks.withdrawPublishRequest.useMutation();

  if (!features?.appBlocks) return <NotFound />;

  const previewOk = preview?.ok === true;
  const checkingPending = !!previewedSlug && pendingQuery.isFetching;
  const busy =
    encoding ||
    submitMutation.isPending ||
    withdrawMutation.isPending ||
    !!submitted ||
    checkingPending;
  const canSubmit = !!bundle && previewOk && !busy;

  async function handleSubmit() {
    if (!bundle) return;
    setEncoding(true);
    try {
      // If the user already has a pending request for this slug, withdraw
      // it server-side first. The /apps/submit Alert above the button
      // makes this explicit before the click, so this isn't a surprise.
      if (existingPending) {
        try {
          await withdrawMutation.mutateAsync({
            publishRequestId: existingPending.id,
          });
        } catch (err) {
          showErrorNotification({
            title: 'Could not withdraw existing submission',
            error: err as Error,
          });
          return;
        }
      }
      const bundleBase64 = await fileToBase64(bundle);
      submitMutation.mutate({ bundleBase64 });
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
      <AppsPageLayout
        size="sm"
        title="Submit an app"
        subtitle={
          <>
            The recommended way to author and submit an app is the <Code>civitai</Code> CLI — it
            scaffolds your block and submits it for you. A moderator reviews the manifest + change
            summary, then approves or rejects with feedback. Approved submissions deploy
            automatically. Prefer to do it by hand? You can still upload a ZIP.
          </>
        }
      >
        <SegmentedControl
          fullWidth
          mb="md"
          value={mode}
          onChange={(v) => setMode(v as SubmitMode)}
          data={[
            {
              label: <span data-testid="apps-offsite-submit-mode-block">App Block (CLI)</span>,
              value: 'block',
            },
            {
              label: <span data-testid="apps-offsite-submit-mode-external">External link</span>,
              value: 'external',
            },
          ]}
        />

        {mode === 'external' ? (
          <ExternalSubmitForm />
        ) : submitted ? (
          <SuccessCard submitted={submitted} />
        ) : (
          <>
              {/* PRIMARY: the recommended CLI flow. */}
              <CliSubmitCta />

              {/* SECONDARY: manual ZIP upload, de-emphasized behind a toggle. */}
              <ManualUploadSection>
                <Text size="sm" c="dimmed">
                  Upload a ZIP of your app source. The slug, version, and name come from{' '}
                  <Code>block.manifest.json</Code> — no separate fields to fill in, and you
                  don&apos;t set <Code>iframe.src</Code> (the platform assigns it from your slug).
                </Text>

                <FileInput
                  label="App bundle (.zip)"
                  description={`ZIP of your app source: block.manifest.json + index.html + src/. No Dockerfile/nginx needed — the platform builds + serves it. Max ${Math.round(
                    MAX_BUNDLE_SIZE_BYTES / (1024 * 1024)
                  )} MiB.`}
                  placeholder="my-app.zip"
                  accept=".zip,application/zip,application/x-zip-compressed"
                  value={bundle}
                  onChange={setBundle}
                  leftSection={<IconFileZip size={16} />}
                  required
                  data-autofocus
                />

                {preview && <ManifestPreviewCard preview={preview} />}

                {previewOk && (checkingPending || existingPending) && (
                  <PendingNotice loading={checkingPending} pending={existingPending} />
                )}

                <Alert
                  icon={<IconCheck size={16} />}
                  color="blue"
                  variant="light"
                  title="What happens next"
                >
                  <Text size="sm" mb={6}>
                    1. We store your bundle and compute a diff against the previous approved version
                    (if any).
                  </Text>
                  <Text size="sm" mb={6}>
                    2. A moderator reviews the manifest + change summary on{' '}
                    <Code>/apps/review</Code>.
                  </Text>
                  <Text size="sm" mb={6}>
                    3. On approve, the platform deploys your build to{' '}
                    <Code>
                      {previewOk && preview.ok
                        ? `${preview.manifest.blockId}.civit.ai`
                        : '<slug>.civit.ai'}
                    </Code>{' '}
                    automatically.
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
                    leftSection={
                      existingPending ? <IconRefresh size={16} /> : <IconCloudUpload size={16} />
                    }
                    color={existingPending ? 'yellow' : undefined}
                    onClick={handleSubmit}
                    disabled={!canSubmit}
                    loading={busy}
                  >
                    {existingPending ? 'Withdraw and resubmit' : 'Submit for review'}
                  </Button>
                </Group>
              </ManualUploadSection>
            </>
          )}
      </AppsPageLayout>
    </>
  );
}

function PendingNotice({
  loading,
  pending,
}: {
  loading: boolean;
  pending: { id: string; version: string; submittedAt: string | Date } | null;
}) {
  if (loading) {
    return (
      <Alert color="gray" variant="light" icon={<Loader size={14} />}>
        <Text size="sm">Checking for an existing pending submission…</Text>
      </Alert>
    );
  }
  if (!pending) return null;
  const submittedAt =
    typeof pending.submittedAt === 'string' ? new Date(pending.submittedAt) : pending.submittedAt;
  return (
    <Alert
      color="yellow"
      variant="light"
      icon={<IconAlertTriangle size={16} />}
      title="You already have a pending submission for this slug"
    >
      <Stack gap={4}>
        <Text size="sm">
          v<Code>{pending.version}</Code> submitted{' '}
          {Number.isFinite(submittedAt.getTime()) ? submittedAt.toLocaleString() : 'recently'} is
          still in the moderator queue. Submitting this bundle will withdraw that request and put
          this one in its place.
        </Text>
        <Text size="xs" c="dimmed">
          {pending.id}
        </Text>
      </Stack>
    </Alert>
  );
}

function ManifestPreviewCard({ preview }: { preview: ManifestPreview }) {
  if (!preview.ok) {
    return (
      <Alert
        color="red"
        variant="light"
        icon={<IconAlertTriangle size={16} />}
        title="Bundle problem"
      >
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {preview.error}
        </Text>
      </Alert>
    );
  }
  const m = preview.manifest;
  return (
    <Alert color="green" variant="light" icon={<IconCheck size={16} />} title="Manifest parsed">
      <Stack gap={6}>
        <Group gap={6}>
          <Text size="sm" fw={600}>
            Slug
          </Text>
          <Code>{m.blockId}</Code>
          <Text size="sm" fw={600} ml="md">
            Version
          </Text>
          <Code>{m.version}</Code>
        </Group>
        <Group gap={6}>
          <Text size="sm" fw={600}>
            Name
          </Text>
          <Text size="sm">{m.name}</Text>
        </Group>
        {m.description && (
          <Group gap={6} align="flex-start">
            <Text size="sm" fw={600} style={{ minWidth: 80 }}>
              Description
            </Text>
            <Text size="sm" c="dimmed" style={{ flex: 1 }}>
              {m.description}
            </Text>
          </Group>
        )}
        {m.contentRating && (
          <Group gap={6}>
            <Text size="sm" fw={600}>
              Rating
            </Text>
            <Badge color="gray" variant="light">
              {m.contentRating}
            </Badge>
          </Group>
        )}
        {m.targets && m.targets.length > 0 && (
          <Group gap={6}>
            <Text size="sm" fw={600}>
              Slots
            </Text>
            {m.targets.map((t, i) => (
              <Code key={i}>{t.slotId ?? '?'}</Code>
            ))}
          </Group>
        )}
      </Stack>
    </Alert>
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
          Your submission for <Code>{submitted.slug}</Code> v<Code>{submitted.version}</Code> is in
          the moderator queue. You'll see the result on{' '}
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
