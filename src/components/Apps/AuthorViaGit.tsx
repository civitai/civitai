import {
  Alert,
  Box,
  Button,
  Code,
  CopyButton,
  Group,
  Loader,
  Stack,
  Text,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconBrandGit,
  IconCheck,
  IconClipboard,
  IconEye,
  IconEyeOff,
} from '@tabler/icons-react';
import { useState } from 'react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { maskCloneUrlCredential } from '~/components/Apps/git-access';
import { trpc } from '~/utils/trpc';

/**
 * Phase 3 (git-push self-service) — developer-facing "Author via git" panel for
 * an APPROVED app the viewer owns, rendered inline on /apps/my-submissions.
 *
 * Lazy by design: the panel does NOT fetch on page load. `blocks.getMyAppRepo`
 * lazily provisions a scoped Forgejo identity + grants the caller write on their
 * repo as a SIDE EFFECT (see the router), so it must be user-initiated — the
 * query is `enabled` only once the user clicks "Show git access" (revealed=true).
 *
 * Credential handling: the clone URL embeds a live push token. We render it
 * MASKED by default (the token replaced with •••) and only reveal the real URL
 * when the user clicks "Reveal" — the token is never in the DOM on first paint of
 * the panel. Copy buttons copy the REAL (unmasked) value regardless of the
 * reveal toggle, so the user can copy without exposing it on screen.
 */

// Local mirror of the getMyAppRepo return shape (blocks.router.ts getMyAppRepo)
// so this component doesn't pull the full RouterOutput type into the page.
type RepoAvailable = {
  notYetAvailable: false;
  slug: string;
  httpUrl: string;
  cloneUrl: string;
  forgejoUsername: string;
  instructions: string;
  firstVersionIsZip: false;
};
type RepoNotYet = {
  notYetAvailable: true;
  slug: string;
  firstVersionIsZip: true;
  message: string;
};
type GetMyAppRepoResult = RepoAvailable | RepoNotYet;

function CopyableCode({ value, display }: { value: string; display?: string }) {
  return (
    <CopyButton value={value}>
      {({ copied, copy }) => (
        <Box pos="relative" onClick={copy} style={{ cursor: 'pointer' }}>
          <Code
            block
            color={copied ? 'green' : undefined}
            style={{ wordBreak: 'break-all', paddingRight: 36 }}
          >
            {copied ? 'Copied' : display ?? value}
          </Code>
          <LegacyActionIcon
            className="absolute right-2 top-1/2 -translate-y-1/2"
            right={8}
            variant="transparent"
            color="gray"
            aria-label="Copy"
          >
            {copied ? <IconCheck size={16} /> : <IconClipboard size={16} />}
          </LegacyActionIcon>
        </Box>
      )}
    </CopyButton>
  );
}

function GitAccessPanel({ appBlockId }: { appBlockId: string }) {
  const [showToken, setShowToken] = useState(false);

  // Lazy: only fires because this panel is mounted (parent gates mount on the
  // user clicking "Show git access"). enabled is still scoped to a valid id.
  const repoQuery = trpc.blocks.getMyAppRepo.useQuery(
    { appBlockId },
    {
      enabled: !!appBlockId,
      // The token-bearing clone URL is sensitive — don't keep it warm.
      staleTime: 0,
      gcTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
    }
  );

  if (repoQuery.isLoading) {
    return (
      <Group gap="xs" py="xs">
        <Loader size="xs" />
        <Text size="sm" c="dimmed">
          Provisioning your git access…
        </Text>
      </Group>
    );
  }

  if (repoQuery.isError) {
    // Non-owner → FORBIDDEN; not-found → NOT_FOUND. Show a muted message, never
    // crash. (The page only renders this panel for owned approved rows, so this
    // is the defensive path.)
    return (
      <Alert color="gray" variant="light" icon={<IconAlertTriangle size={16} />} py="xs">
        <Text size="sm">{repoQuery.error.message}</Text>
      </Alert>
    );
  }

  const data = repoQuery.data as GetMyAppRepoResult | undefined;
  if (!data) return null;

  if (data.notYetAvailable) {
    return (
      <Text size="sm" c="dimmed">
        {data.message}
      </Text>
    );
  }

  const maskedCloneUrl = maskCloneUrlCredential(data.cloneUrl);

  return (
    <Stack gap="sm" py="xs">
      <Text size="sm" fw={500}>
        Clone URL
      </Text>
      <Stack gap={4}>
        <CopyableCode
          value={data.cloneUrl}
          display={showToken ? data.cloneUrl : maskedCloneUrl}
        />
        <Group justify="space-between">
          <Button
            size="compact-xs"
            variant="subtle"
            leftSection={
              showToken ? <IconEyeOff size={14} /> : <IconEye size={14} />
            }
            onClick={() => setShowToken((v) => !v)}
          >
            {showToken ? 'Hide token' : 'Reveal token'}
          </Button>
          <Text size="xs" c="dimmed">
            This URL contains a push token — treat it like a password.
          </Text>
        </Group>
      </Stack>

      <Text size="sm" fw={500}>
        Steps
      </Text>
      <CopyableCode value={data.instructions} />

      <Alert color="blue" variant="light" py="xs">
        <Text size="xs">
          Your first version is uploaded as a ZIP; new versions can be pushed with
          git. Pushes go to moderator review — they never deploy automatically.
        </Text>
      </Alert>
    </Stack>
  );
}

/**
 * Collapsible "Author via git" affordance. The parent (my-submissions row)
 * renders this only for APPROVED rows the user owns (the server still owner-gates
 * the underlying query). The query does not fire until the panel is expanded.
 */
export function AuthorViaGit({ appBlockId }: { appBlockId: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Stack gap="xs">
      <Group>
        <Button
          size="xs"
          variant="light"
          leftSection={<IconBrandGit size={14} />}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Hide git access' : 'Author via git'}
        </Button>
      </Group>
      {/* Mount-on-expand so the side-effecting getMyAppRepo only runs when the
          user opts in (it provisions a Forgejo identity). */}
      {expanded && <GitAccessPanel appBlockId={appBlockId} />}
    </Stack>
  );
}
