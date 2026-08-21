import {
  Alert,
  Anchor,
  Card,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  UnstyledButton,
} from '@mantine/core';
import { IconExternalLink, IconInfoCircle, IconTerminal2 } from '@tabler/icons-react';
import type { MouseEvent, ReactNode } from 'react';
import { STANDALONE_KIND_LABEL } from '~/components/Apps/listingKindLabels';
import { useEligibleOauthClients } from '~/components/Apps/useEligibleOauthClients';

/**
 * /apps/submit type-picker (W13). The author first picks HOW to list their app:
 * an on-platform **App** (authored + submitted with the `civitai` CLI) or a
 * **Standalone** app (a marketplace card that links the caller's OAuth app, with an
 * optional homepage link). Each type is a large selectable card; picking one calls
 * `onSelect`, and the page reveals that flow + a "choose a different type" affordance.
 *
 * The internal mode id keeps the historical `block` value for the on-platform
 * app — only the label/copy is "App"; the code id is never renamed. The former
 * separate `'connect'` mode was MERGED into `'external'` (every standalone app IS an
 * OAuth app — one listing links the OAuth client + carries an optional homepage URL).
 * `'external'` likewise stays the mode ID: the WORD changed, the VALUE did not.
 *
 * ## 🔴 THE PREREQUISITE IS SURFACED HERE, BEFORE ANY WORK
 *
 * Measured on production: a developer picked the standalone card, typed a URL, hit
 * Next (which fires a server-side metadata fetch), landed on step 2 — and only THERE
 * learned they own no eligible OAuth client, with `Next` disabled. A hard dead-end,
 * reached only after doing work. The requirement is a property of the CHOICE, so it
 * belongs at the choice.
 *
 * ## 🔴 WHY THE CARD STAYS CLICKABLE (and is not disabled)
 *
 * Deliberate, and the more conservative of the two options:
 *  - the notice is driven by a CLIENT-SIDE read that can be wrong (an error, a stale
 *    cache, a race with a client the user just registered). Disabling on it would
 *    manufacture an unrecoverable dead-end WORSE than the one being fixed — the user
 *    could not even reach the step that explains itself;
 *  - a `disabled` control is removed from the tab order, so a keyboard / screen-reader
 *    user would get the block without ever hearing the reason;
 *  - nothing invalid can be submitted anyway: step 2 still gates `Next` on a selected
 *    client, and the server re-checks ownership at submit.
 * So the card informs and offers the fix, rather than refusing.
 */
export type SubmitMode = 'block' | 'external';

/** The exact prerequisite sentence. Pinned by test; reworded only deliberately. */
export const STANDALONE_OAUTH_PREREQUISITE_TEXT =
  'Listing a standalone app requires an OAuth app — that is what lets people sign in to your app with their Civitai account. You do not have one yet.';

export function SubmitModeSelector({ onSelect }: { onSelect: (mode: SubmitMode) => void }) {
  const oauthClients = useEligibleOauthClients();

  // 🔴 A confirmed-empty list is the ONLY state that shows the notice. `'unknown'`
  // (loading OR errored) must render nothing — an in-flight fetch is not evidence
  // that the developer owns no OAuth app.
  const showPrerequisite = oauthClients.status === 'ready' && !oauthClients.hasEligibleClient;

  return (
    <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="md" data-testid="apps-submit-mode-selector">
      <ModeCard
        icon={<IconTerminal2 size={22} />}
        title="App"
        description="An on-platform app authored + submitted with the civitai CLI. The CLI scaffolds your block and submits it — a moderator reviews, then it deploys to your <slug>.civit.ai."
        onSelect={() => onSelect('block')}
        testId="apps-submit-mode-card-app"
      />
      <ModeCard
        icon={<IconExternalLink size={22} />}
        title={`List a ${STANDALONE_KIND_LABEL} app (connect your OAuth app)`}
        description={`List a ${STANDALONE_KIND_LABEL} app hosted elsewhere by linking your registered OAuth app so users can grant it access. Disclose the scopes your app requests and why, add an optional homepage link — a moderator reviews before it appears.`}
        onSelect={() => onSelect('external')}
        testId="apps-submit-mode-card-external"
        footer={
          showPrerequisite ? (
            <Alert
              color="yellow"
              variant="light"
              p="xs"
              icon={<IconInfoCircle size={16} />}
              data-testid="apps-submit-mode-external-prerequisite"
            >
              <Text size="xs">
                {STANDALONE_OAUTH_PREREQUISITE_TEXT}{' '}
                <Anchor
                  href="/user/account"
                  target="_blank"
                  rel="noopener noreferrer"
                  size="xs"
                  // Stop the click bubbling to the card's own button — the link is a
                  // DIFFERENT destination, and picking the mode as a side effect of
                  // opening account settings would be a surprise.
                  onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
                  data-testid="apps-submit-mode-external-prerequisite-link"
                >
                  Register an OAuth app in your account settings
                </Anchor>
                , then come back — this opens in a new tab.
              </Text>
            </Alert>
          ) : null
        }
      />
    </SimpleGrid>
  );
}

function ModeCard({
  icon,
  title,
  description,
  onSelect,
  testId,
  footer,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  onSelect: () => void;
  testId: string;
  footer?: ReactNode;
}) {
  return (
    <UnstyledButton onClick={onSelect} data-testid={testId} h="100%" style={{ height: '100%' }}>
      <Card withBorder p="lg" h="100%" className="hover:border-blue-5">
        <Stack gap="sm">
          <ThemeIcon size={44} radius="md" variant="light">
            {icon}
          </ThemeIcon>
          <Text fw={600} size="lg">
            {title}
          </Text>
          <Text size="sm" c="dimmed">
            {description}
          </Text>
          {footer}
        </Stack>
      </Card>
    </UnstyledButton>
  );
}
