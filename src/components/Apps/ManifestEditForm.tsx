import {
  Alert,
  Button,
  Checkbox,
  Group,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { IconAlertTriangle, IconDeviceFloppy, IconInfoCircle } from '@tabler/icons-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ALLOWED_CONTENT_RATINGS } from '~/server/services/block-manifest-validator.service';
import { MODEL_SLOT_IDS } from '~/shared/constants/slot-registry';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * App management (Phase 1) — web form to edit an app's manifest. On save it
 * calls `blocks.updateManifest`, which does a BACKGROUND commit to the app's
 * Forgejo repo and re-enters the no-trust pending-review flow (the change does
 * NOT go live until a moderator approves it via /apps/review).
 *
 * blockId is IMMUTABLE (shown read-only). iframe.src is platform-owned and not
 * editable here (the server stamps it). The SERVER re-validates every field with
 * BlockManifestValidator — this form's hints are advisory only.
 */

const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

type StoredManifest = Record<string, unknown> & {
  blockId?: string;
  version?: string;
  name?: string;
  description?: string;
  contentRating?: string;
  scopes?: string[];
  targets?: Array<{ slotId?: string }>;
};

export function ManifestEditForm({
  appBlockId,
  slug,
  currentVersion,
  manifest,
}: {
  appBlockId: string;
  slug: string;
  currentVersion: string;
  manifest: StoredManifest;
}) {
  const utils = trpc.useUtils();

  const [name, setName] = useState<string>(manifest.name ?? '');
  const [description, setDescription] = useState<string>(manifest.description ?? '');
  const [contentRating, setContentRating] = useState<string>(manifest.contentRating ?? 'g');
  const [version, setVersion] = useState<string>(bumpPatch(currentVersion));
  const [scopesText, setScopesText] = useState<string>((manifest.scopes ?? []).join('\n'));
  const [selectedSlots, setSelectedSlots] = useState<string[]>(
    (manifest.targets ?? []).map((t) => t?.slotId).filter((s): s is string => !!s)
  );

  const scopes = useMemo(
    () =>
      scopesText
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    [scopesText]
  );

  const versionValid = SEMVER_RE.test(version);
  const versionHigher = compareSemver(version, currentVersion) > 0;

  const mutation = trpc.blocks.updateManifest.useMutation({
    onSuccess: async (res) => {
      showSuccessNotification({
        title: 'Manifest update submitted for review',
        message: `v${res.version} is now pending moderator review. It will not go live until approved.`,
      });
      await utils.blocks.getMyAppManifest.invalidate({ appBlockId });
    },
    onError: (err) => {
      showErrorNotification({ title: 'Could not submit manifest update', error: new Error(err.message) });
    },
  });

  function handleSave() {
    mutation.mutate({
      appBlockId,
      patch: {
        version,
        name: name.trim() || undefined,
        description: description.trim() || undefined,
        contentRating,
        scopes,
        targets: selectedSlots.map((slotId) => ({ slotId })),
      },
    });
  }

  const canSave = versionValid && versionHigher && !mutation.isPending && name.trim().length > 0;

  return (
    <Stack gap="md">
      <Title order={3}>Edit manifest</Title>

      <Alert icon={<IconInfoCircle size={16} />} color="blue" variant="light">
        Saving commits the new manifest to your app&apos;s repository and opens a moderator review.
        The change does <strong>not</strong> go live until a moderator approves it. blockId
        (<code>{slug}</code>) cannot be changed.
      </Alert>

      <TextInput label="Block ID (immutable)" value={slug} readOnly disabled />

      <TextInput
        label="Name"
        required
        value={name}
        onChange={(e) => setName(e.currentTarget.value)}
        error={name.trim().length === 0 ? 'Name is required' : undefined}
      />

      <Textarea
        label="Description"
        autosize
        minRows={2}
        maxRows={6}
        value={description}
        onChange={(e) => setDescription(e.currentTarget.value)}
      />

      <Select
        label="Content rating"
        data={[...ALLOWED_CONTENT_RATINGS].map((r) => ({ value: r, label: r }))}
        value={contentRating}
        onChange={(v) => setContentRating(v ?? 'g')}
      />

      <TextInput
        label="New version"
        description={`Must be greater than the current version (${currentVersion}).`}
        required
        value={version}
        onChange={(e) => setVersion(e.currentTarget.value)}
        error={
          !versionValid
            ? 'Must be a semantic version (e.g. 1.2.3)'
            : !versionHigher
            ? `Must be greater than ${currentVersion}`
            : undefined
        }
      />

      <Textarea
        label="Scopes"
        description="One scope per line (or comma-separated). Must be a subset of your app's granted scopes — the server enforces this."
        autosize
        minRows={2}
        maxRows={8}
        value={scopesText}
        onChange={(e) => setScopesText(e.currentTarget.value)}
      />

      <Stack gap={4}>
        <Text size="sm" fw={500}>
          Target slots
        </Text>
        <Text size="xs" c="dimmed">
          Where the block mounts on a model page.
        </Text>
        <Checkbox.Group value={selectedSlots} onChange={setSelectedSlots}>
          <Stack gap={4} mt={4}>
            {MODEL_SLOT_IDS.map((slotId) => (
              <Checkbox key={slotId} value={slotId} label={slotId} />
            ))}
          </Stack>
        </Checkbox.Group>
      </Stack>

      {mutation.error && (
        <Alert icon={<IconAlertTriangle size={16} />} color="red" variant="light">
          {mutation.error.message}
        </Alert>
      )}

      <Group justify="flex-end">
        <Button component={Link} href={`/apps/${appBlockId}`} variant="default">
          Cancel
        </Button>
        <Button
          leftSection={<IconDeviceFloppy size={16} />}
          onClick={handleSave}
          loading={mutation.isPending}
          disabled={!canSave}
        >
          Save &amp; submit for review
        </Button>
      </Group>

      {mutation.data && (
        <Alert color="green" variant="light">
          Submitted as review request <code>{mutation.data.publishRequestId}</code>. Track it on{' '}
          <Link href="/apps/my-submissions">My submissions</Link>.
        </Alert>
      )}
    </Stack>
  );
}

/** Bump the patch component of a semver string for a sensible default new version. */
function bumpPatch(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return v;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/** Mirror of the server's compareSemver (advisory client-side gate only). */
function compareSemver(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre = null] = v.split('-', 2);
    const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre };
  };
  const A = split(a);
  const B = split(b);
  for (let i = 0; i < 3; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1;
  }
  if (A.pre === null && B.pre === null) return 0;
  if (A.pre === null) return 1;
  if (B.pre === null) return -1;
  return A.pre < B.pre ? -1 : A.pre > B.pre ? 1 : 0;
}
