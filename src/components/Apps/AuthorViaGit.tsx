import { Alert, Button, Code, Group, Loader, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconBrandGit, IconEye, IconEyeOff } from '@tabler/icons-react';
import { useState } from 'react';
import {
  COPY_BODY_PADDING_RIGHT,
  CopyAffordance,
} from '~/components/CopyAffordance/CopyAffordance';
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

/**
 * A copyable code block whose DISPLAYED text may be masked while the clipboard gets the real
 * value — the clone URL and the setup steps both embed a push token.
 *
 * 🔴 THIS WAS THE FIFTH BYTE-IDENTICAL PRIVATE COPY OF THE COPY BUTTON, and it had already
 * drifted. `CopyableCommand`'s header records that three copies existed before it was
 * extracted; this one was not among them and nobody counted it, so `CopyAffordance` was
 * written believing it was preventing a fourth. Its `aria-label` was the bare string `"Copy"`
 * on BOTH instances below — two controls on one panel with the same accessible name, which is
 * precisely the drift `CopyableCommand`'s header names as the reason the component exists.
 * Now it is the shared mechanics plus a body, and each control says what it copies.
 *
 * Nothing else about it changes: `value` and the displayed body were already separate here,
 * which is why `CopyAffordance`'s `value` + render-prop shape fits with no new prop. It
 * inherits the `stopPropagation()` on the icon (this copy had no icon handler at all, so it
 * fired once by bubbling; it still fires once).
 *
 * 🔴 ONE DELIBERATE BEHAVIOUR CHANGE: `bodyClickCopies={false}`. Clicking the BLOCK no longer
 * copies — only the control does. Both bodies are multi-line text a reader plausibly selects
 * a fragment of, and with a body-wide click target the `click` ending that drag-select
 * replaced the selection with the whole value and re-rendered the body to "Copied".
 *
 * ⚠️ NOT AN EXFILTRATION FIX, AND WORTH NOT OVERSTATING: the value goes to the user's OWN
 * clipboard, and the token is masked on screen either way. The harm is unexpected clipboard
 * contents and a destroyed selection — on a block whose string happens to be a credential,
 * which is why it is this body rather than a command one-liner. Guarding it instead was tried
 * and abandoned; see `CopyAffordance`'s `bodyClickCopies` note. The control is a real
 * `<button>`, reachable by Tab, and now says which of the two things it copies.
 */
function CopyableCode({
  value,
  display,
  label,
}: {
  value: string;
  display?: string;
  /** What this control copies. Required, so two of them on one panel cannot collide again. */
  label: string;
}) {
  return (
    <CopyAffordance value={value} label={label} bodyClickCopies={false}>
      {({ copied }) => (
        <Code
          block
          color={copied ? 'green' : undefined}
          style={{ wordBreak: 'break-all', paddingRight: COPY_BODY_PADDING_RIGHT }}
        >
          {copied ? 'Copied' : display ?? value}
        </Code>
      )}
    </CopyAffordance>
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
          label="Copy clone URL"
        />
        <Group justify="space-between">
          <Button
            size="compact-xs"
            variant="subtle"
            leftSection={showToken ? <IconEyeOff size={14} /> : <IconEye size={14} />}
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
      {/* instructions embed the same token-bearing clone URL — mask it under the
          same reveal toggle so the token isn't shown in cleartext on first paint
          (copy still copies the real value). */}
      <CopyableCode
        value={data.instructions}
        display={showToken ? data.instructions : maskCloneUrlCredential(data.instructions)}
        label="Copy setup steps"
      />

      <Alert color="blue" variant="light" py="xs">
        <Text size="xs">
          Your first version is uploaded as a ZIP; new versions can be pushed with git. Pushes go to
          moderator review — they never deploy automatically.
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
