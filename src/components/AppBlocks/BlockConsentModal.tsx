import {
  Button,
  Group,
  List,
  Modal,
  NumberInput,
  Stack,
  Switch,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { IconShieldLock } from '@tabler/icons-react';
import { useState } from 'react';
import { blockScopePermissions } from '~/components/Apps/listingPermissions';
import { ListingPermissionGroups } from '~/components/Apps/ListingPermissionsDisclosure';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import {
  BLOCK_CONSENT_BUDGET_DEFAULT_PER_DAY,
  BLOCK_CONSENT_BUDGET_LOW_WARN_PER_DAY,
  BLOCK_CONSENT_BUDGET_LOW_WARNING_BODY,
  BLOCK_CONSENT_BUDGET_MAX_PER_DAY,
  BLOCK_CONSENT_BUDGET_MIN_PER_DAY,
  BLOCK_SPEND_SCOPE,
} from '~/shared/constants/block-scope.constants';
import {
  APP_STORAGE_IMPORT_SCOPE,
  APP_STORAGE_PUBLISH_SCOPE,
} from '~/shared/constants/block-storage.constants';
import { trpc } from '~/utils/trpc';

interface BlockConsentModalProps {
  appBlockId: string;
  blockName?: string;
  /** The consent-gated scopes the app declares but the viewer hasn't granted. */
  missingScopes: string[];
  /** Called after the grant lands so the host can re-mint the block token. */
  onGranted: () => void;
  /**
   * The blockId of a SOURCE app this app imports from, when the block asked for
   * `apps:storage:publish` THERE (`REQUEST_CONSENT { scopes, from }`). The prompt then names
   * that app, and Allow records the grant for it, not for this app.
   */
  from?: string;
}

/* The ONE scope in the vocabulary that can spend the viewer's Buzz is `BLOCK_SPEND_SCOPE`, imported
   above from `~/shared/constants/block-scope.constants` and not re-declared here. Three surfaces
   must agree about it — this modal decides whether to OFFER the budget field, the editor on
   /apps/activity decides what to SEND, and the revoke dialog says that withdrawing it CLEARS the
   stored limit — and a local const per surface is exactly the shape that lets them disagree. If the
   grant modal looks at a different string from the one the server caps against, a spend path stops
   being bounded.

   ⚠️ RE-ANCHORED, AND THE HAZARD IS THE REASON RATHER THAN TIDINESS. This was a JSDOC DOCBLOCK
   belonging to a private `const SPEND_SCOPE` that phase 3 deleted, left behind with a blank line
   under it — so by the time anyone read it, it documented the NEXT declaration, which is the
   component below. `scope-grant.service.ts` records that exact hazard by name on
   `WRITE_RETURN_SELECT` ("A docblock separated from its function by another declaration documents
   that declaration instead") and it was walked into here anyway. A plain block comment cannot
   attach to a declaration at all, which is what makes this spelling the correct one for prose about
   an ABSENT declaration — and it is the spelling `src/pages/apps/activity.tsx` already used when
   the same const was deleted there in the same change. (Do not "restore" the JSDoc stars: a
   docblock over nothing is the defect, not the formatting.) */

/**
 * Lazy-consent surface (A6 / design-gaps C2). Opened on demand when a block
 * fires REQUEST_CONSENT — i.e. a logged-in viewer clicked an action (Generate)
 * whose consent-gated scope the token doesn't carry yet. Unlike the old
 * at-load consent Alert (rendered above the block on first load), this is a
 * modal triggered at the point of the action: the block renders in full, and
 * the user only sees the permission ask the moment they try to use the capability.
 *
 * On accept it records the grant via `blocks.grantScopes` (bounded server-side
 * to manifest∩approved) then closes and calls `onGranted`, which re-mints the
 * block token so it carries the newly-granted scopes. The block observes the
 * scope appear on its token (via TOKEN_REFRESH) and retries the action.
 *
 * ## The spend limit
 *
 * When `ai:write:budgeted` is among the scopes being consented to, the user can
 * also set a per-day Buzz limit for THIS app, which the server enforces as a
 * per-(user, app, UTC-day) reservation on every spend path. The control is shown
 * ONLY for that scope, because it is the only one that can spend anything — a
 * limit next to "read your username" would be noise.
 *
 * OFF BY DEFAULT, and that is the honest default rather than a lazy one: with the
 * switch off the field is OMITTED from the mutation, so a first-time grant stores
 * NULL — exactly what every already-consented user has — and an app that already has
 * a limit KEEPS it. Nobody is silently tightened and nobody is silently loosened. The
 * platform's own per-user daily ceiling applies either way; a limit set here only ever
 * narrows.
 *
 * ⚠️ THIS MODAL IS A WRITE-ONLY SURFACE, BY DESIGN. It is opened on `missingScopes`,
 * which is empty for every scope the user has already granted — so it can be shown at
 * most once per app for the spend scope, and it never reads the stored budget.
 * Raising, lowering, clearing and even SEEING a limit live on /apps/activity
 * (`AppBudgetControl`), which does read it. Do not add "your current limit is …" copy
 * here without giving the modal that read; the off-state copy below is worded to be
 * true WITHOUT it.
 */
export default function BlockConsentModal({
  appBlockId,
  blockName,
  missingScopes,
  onGranted,
  from,
}: BlockConsentModalProps) {
  const dialog = useDialogContext();
  const [error, setError] = useState<string | null>(null);
  const forSource = from !== undefined;
  const grantsSpend = !forSource && missingScopes.includes(BLOCK_SPEND_SCOPE);
  const grantsImport = !forSource && missingScopes.includes(APP_STORAGE_IMPORT_SCOPE);
  // The import consent covers every source app the approved manifest imports from, so the
  // prompt names each one and its collections before the viewer allows it. A prompt for a source
  // app reads the same list, for that source's name and whether this app may write there.
  const imports = trpc.blocks.getStorageImports.useQuery(
    { appBlockId },
    { enabled: grantsImport || forSource }
  );
  const source = forSource
    ? imports.data?.imports.find(
        (i) => i.from === from && i.access === 'readwrite' && i.sourceAppBlockId !== null
      )
    : undefined;
  // `from` is the block's own text: until the server's imports name the source, say "another app"
  // rather than show it.
  const sourceName = source ? source.sourceName ?? source.from : 'another app';
  const appLabel = blockName ?? 'This app';
  const [limitEnabled, setLimitEnabled] = useState(false);
  const [budget, setBudget] = useState<number | string>(BLOCK_CONSENT_BUDGET_DEFAULT_PER_DAY);
  const grant = trpc.blocks.grantScopes.useMutation({
    onSuccess: () => {
      setError(null);
      onGranted();
      dialog.onClose();
    },
    onError: (e) => setError(e.message),
  });

  // Clamp defensively rather than trusting the input's own bounds: Mantine's
  // NumberInput hands back a string while the field is mid-edit (and an empty
  // string when cleared), so the value reaching the mutation must be narrowed to a
  // real integer in range or dropped entirely. The server re-validates regardless —
  // this only keeps the request well-formed.
  const parsedBudget = typeof budget === 'number' ? budget : Number.parseInt(String(budget), 10);
  const budgetValid =
    Number.isInteger(parsedBudget) &&
    parsedBudget >= BLOCK_CONSENT_BUDGET_MIN_PER_DAY &&
    parsedBudget <= BLOCK_CONSENT_BUDGET_MAX_PER_DAY;
  const budgetBlocksSubmit = grantsSpend && limitEnabled && !budgetValid;

  return (
    <Modal
      {...dialog}
      withCloseButton={false}
      title={
        forSource ? `${appLabel} needs permission in ${sourceName}` : `${appLabel} needs permission`
      }
    >
      <Stack gap="md">
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <ThemeIcon color="yellow" variant="light" size="lg">
            <IconShieldLock size={20} />
          </ThemeIcon>
          <Text size="sm">
            To do that, <strong>{blockName ?? 'this app'}</strong> needs your permission
            {forSource ? (
              <>
                {' '}
                in <strong>{sourceName}</strong>
              </>
            ) : null}{' '}
            to:
          </Text>
        </Group>
        <ListingPermissionGroups
          permissions={blockScopePermissions(missingScopes)}
          marker="neutral"
          renderDetail={(scope) =>
            forSource && scope === APP_STORAGE_PUBLISH_SCOPE ? (
              <SourcePublishConsentDetail
                consumerName={appLabel}
                sourceName={sourceName}
                available={source !== undefined}
                loading={imports.isLoading}
              />
            ) : !forSource && scope === APP_STORAGE_IMPORT_SCOPE ? (
              <StorageImportConsentDetail
                consumerName={blockName ?? 'This app'}
                imports={imports.data?.imports}
                loading={imports.isLoading}
              />
            ) : null
          }
        />
        {grantsSpend ? (
          <Stack gap="xs" data-testid="block-consent-budget">
            <Switch
              size="sm"
              checked={limitEnabled}
              onChange={(event) => setLimitEnabled(event.currentTarget.checked)}
              label="Set a daily Buzz limit for this app"
              data-testid="block-consent-budget-toggle"
            />
            {limitEnabled ? (
              <NumberInput
                size="xs"
                label="Buzz per day"
                description={`This app can spend at most this much of your Buzz each day. Max ${BLOCK_CONSENT_BUDGET_MAX_PER_DAY.toLocaleString()}.`}
                min={BLOCK_CONSENT_BUDGET_MIN_PER_DAY}
                max={BLOCK_CONSENT_BUDGET_MAX_PER_DAY}
                step={100}
                allowDecimal={false}
                allowNegative={false}
                value={budget}
                onChange={setBudget}
                error={budgetValid ? null : 'Enter a whole number within the allowed range'}
                data-testid="block-consent-budget-input"
              />
            ) : (
              // 🔴 THIS DOES NOT SAY "no limit set", AND THAT IS THE FIX. This modal
              // never reads the stored budget — leaving the switch off OMITS the field,
              // which means "leave whatever is stored alone", not "there is no limit".
              // A user who set a limit earlier (or who re-consents after a revoke, which
              // does not clear the stored number) would have been told, falsely, that
              // nothing bounds this app while their old limit was still being enforced.
              // Manage the actual value on /apps/activity, which reads it.
              <Text size="xs" c="dimmed" data-testid="block-consent-budget-off">
                Any limit you have already set for this app stays as it is. Manage it under Apps →
                Permissions. This app always spends under your account&rsquo;s overall daily cap.
              </Text>
            )}
            {/* A very low limit is storable (the floor is 1) and enforced exactly as
                given, so say what it does at the moment it is chosen. 🔴 THE SENTENCE IS
                SHARED — BLOCK_CONSENT_BUDGET_LOW_WARNING_BODY — so this surface and the
                editor on /apps/activity cannot drift. Its wording rules, and the five
                wordings that shipped false, are in that constant's docblock. */}
            {limitEnabled && budgetValid && parsedBudget < BLOCK_CONSENT_BUDGET_LOW_WARN_PER_DAY ? (
              <Text size="xs" c="orange" data-testid="block-consent-budget-low-warning">
                {parsedBudget.toLocaleString()} {BLOCK_CONSENT_BUDGET_LOW_WARNING_BODY} You can
                change it later under Apps → Permissions.
              </Text>
            ) : null}
          </Stack>
        ) : null}
        {error ? (
          <Text size="xs" c="red">
            {error}
          </Text>
        ) : null}
        <Group justify="flex-end" gap="xs">
          <Button size="xs" variant="default" onClick={dialog.onClose} disabled={grant.isPending}>
            Not now
          </Button>
          <Button
            size="xs"
            color="yellow"
            loading={grant.isPending}
            disabled={
              budgetBlocksSubmit || (grantsImport && !imports.data) || (forSource && !source)
            }
            onClick={() =>
              grant.mutate({
                appBlockId,
                scopes: missingScopes,
                // OMITTED unless the user actually set a limit. Sending `null` here
                // would be an explicit CLEAR, which would wipe a budget they set in
                // an earlier consent — a widening performed by a dialog that never
                // mentioned the existing limit. See `recordScopeGrant`.
                ...(grantsSpend && limitEnabled && budgetValid
                  ? { buzzBudgetPerDay: parsedBudget }
                  : {}),
                // Exactly what the list above showed: the server records these and refuses the
                // grant if the app's approved imports are no longer the same.
                ...(grantsImport && imports.data
                  ? {
                      storageImports: imports.data.imports.map((i) => ({
                        from: i.from,
                        collections: i.collections,
                        access: i.access,
                      })),
                    }
                  : {}),
                // The source app the grant is for; the server checks this app imports it.
                ...(forSource ? { from } : {}),
              })
            }
          >
            Allow
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

type StorageImportRow = {
  from: string;
  sourceName: string | null;
  collections: string[];
  access: 'read' | 'readwrite';
};

/** One line per source app: both app names, the collections, and whether it can change them. */
export function StorageImportConsentDetail({
  consumerName,
  imports,
  loading,
}: {
  consumerName: string;
  imports: StorageImportRow[] | undefined;
  loading: boolean;
}) {
  if (loading) {
    return (
      <Text size="xs" c="dimmed">
        Loading which apps…
      </Text>
    );
  }
  if (!imports || imports.length === 0) return null;
  return (
    <List size="xs" spacing={2} mt={4} data-testid="block-consent-storage-imports">
      {imports.map((i) => (
        <List.Item key={i.from}>
          <strong>{consumerName}</strong> {i.access === 'readwrite' ? 'reads and changes' : 'reads'}{' '}
          your {i.collections.join(', ')} in <strong>{i.sourceName ?? i.from}</strong>
          {/* An import is not publish consent in the source: creates, updates, counters and marks
              in its shared collections need `apps:storage:publish` there, separately (deletes do
              not). The block asks for it with `from`, which opens this modal for the source. */}
          {i.access === 'readwrite'
            ? ` — as you. Changing what other people see there, such as adding entries, votes or counts, needs your separate permission in ${
                i.sourceName ?? i.from
              }.`
            : ''}
        </List.Item>
      ))}
    </List>
  );
}

/**
 * The publish grant in a SOURCE app: what the consumer's writes there do, and that the grant is
 * the source's own. `available` is false when the consumer does not import `from` with
 * `readwrite` from an approved app this host shows; the prompt then offers nothing to allow.
 */
export function SourcePublishConsentDetail({
  consumerName,
  sourceName,
  available,
  loading,
}: {
  consumerName: string;
  sourceName: string;
  available: boolean;
  loading: boolean;
}) {
  if (loading) {
    return (
      <Text size="xs" c="dimmed">
        Loading which app…
      </Text>
    );
  }
  if (!available) {
    return (
      <Text size="xs" c="red" mt={4} data-testid="block-consent-source-unavailable">
        {consumerName} does not change your data in that app, so it cannot ask for this permission
        there.
      </Text>
    );
  }
  return (
    <Text size="xs" mt={4} data-testid="block-consent-source-publish">
      Entries, votes and counts that {consumerName} adds in {sourceName} appear publicly there under
      your account. You are giving this permission to {sourceName}, so {sourceName} can do the same.
    </Text>
  );
}
