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
import { SensitiveScopeBadge } from '~/components/Apps/SensitiveScopeBadge';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import {
  BLOCK_CONSENT_BUDGET_DEFAULT_PER_DAY,
  BLOCK_CONSENT_BUDGET_LOW_WARN_PER_DAY,
  BLOCK_CONSENT_BUDGET_MAX_PER_DAY,
  BLOCK_CONSENT_BUDGET_MIN_PER_DAY,
  isSensitiveBlockScope,
} from '~/shared/constants/block-scope.constants';
import { SCOPE_DESCRIPTIONS } from '~/server/services/blocks/scope-descriptions.constants';
import { trpc } from '~/utils/trpc';

interface BlockConsentModalProps {
  appBlockId: string;
  blockName?: string;
  /** The consent-gated scopes the app declares but the viewer hasn't granted. */
  missingScopes: string[];
  /** Called after the grant lands so the host can re-mint the block token. */
  onGranted: () => void;
}

/** The ONE scope in the vocabulary that can spend the viewer's Buzz. */
const SPEND_SCOPE = 'ai:write:budgeted';

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
}: BlockConsentModalProps) {
  const dialog = useDialogContext();
  const [error, setError] = useState<string | null>(null);
  const grantsSpend = missingScopes.includes(SPEND_SCOPE);
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
      title={`${blockName ?? 'This app'} needs permission`}
    >
      <Stack gap="md">
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <ThemeIcon color="yellow" variant="light" size="lg">
            <IconShieldLock size={20} />
          </ThemeIcon>
          <Text size="sm">
            To do that, <strong>{blockName ?? 'this app'}</strong> needs your permission to:
          </Text>
        </Group>
        <List size="sm" spacing={4}>
          {missingScopes.map((scope) => {
            const sensitive = isSensitiveBlockScope(scope);
            return (
              <List.Item key={scope}>
                <Group component="span" gap="xs" wrap="nowrap" align="center">
                  <Text component="span" fw={600} c={sensitive ? 'orange' : undefined}>
                    {SCOPE_DESCRIPTIONS[scope] ?? scope}
                  </Text>
                  {sensitive && <SensitiveScopeBadge size="xs" />}
                </Group>
              </List.Item>
            );
          })}
        </List>
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
                given, so say what it does at the moment it is chosen. */}
            {limitEnabled && budgetValid && parsedBudget < BLOCK_CONSENT_BUDGET_LOW_WARN_PER_DAY ? (
              <Text size="xs" c="orange" data-testid="block-consent-budget-low-warning">
                {parsedBudget.toLocaleString()} Buzz/day is lower than most generations cost — this
                app will refuse to generate until you raise it. You can change it later under Apps →
                Permissions.
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
            disabled={budgetBlocksSubmit}
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
