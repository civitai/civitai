import { Card, Group, Stack, Text, ThemeIcon, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle, IconKey } from '@tabler/icons-react';
import { SensitiveScopeBadge } from '~/components/Apps/SensitiveScopeBadge';
import {
  isSensitiveTokenScope,
  tokenScopeMaskToList,
} from '~/shared/constants/token-scope.constants';

/**
 * ConnectScopesPanel — the OAuth-CONNECT analog of `ManifestScopes`
 * (OnsiteReviewModal). Renders, for a mod reviewing an OFF-SITE connect listing,
 * the OAuth scopes the external app requests + the author's per-scope
 * justification. SENSITIVE scopes (money / private data / cross-user writes — see
 * `SENSITIVE_TOKEN_SCOPES`) render FIRST in a distinct warning-styled group, reusing
 * the shared `SensitiveScopeBadge` so the "elevated-risk" emphasis reads identically
 * to the on-site block review.
 *
 * Display-only: this surface DISPLAYS the developer's stated rationale; it never
 * grants a scope. The server enforces the sensitive-must-justify approval gate
 * (`approveExternalRequest`). The requested-scope bitmask is expanded via
 * `tokenScopeMaskToList` (bit/key/label, sorted by bit); the justification map is
 * keyed by the TokenScope enum-key.
 */
export function ConnectScopesPanel({
  connectClientName,
  requestedScopes,
  justifications,
}: {
  connectClientName?: string | null;
  /** The disclosed TokenScope bitmask the listing requests. */
  requestedScopes: number;
  /** Per-scope rationale keyed by TokenScope enum-key (e.g. `{ ModelsWrite: '…' }`). */
  justifications?: Record<string, string> | null;
}) {
  const scopes = tokenScopeMaskToList(requestedScopes);
  const sensitiveScopes = scopes.filter((s) => isSensitiveTokenScope(s.bit));
  const normalScopes = scopes.filter((s) => !isSensitiveTokenScope(s.bit));

  return (
    <Card withBorder p="sm" data-testid="connect-scopes-panel">
      <Stack gap="xs">
        <Group gap={6}>
          <IconKey size={14} />
          <Text size="sm" fw={600}>
            Requested OAuth permissions ({scopes.length})
          </Text>
          <Tooltip
            multiline
            w={300}
            label="The account permissions this external app asks to be granted when a user connects it. They are bounded by the OAuth client's allowed-scope ceiling; the per-scope note is the developer's stated reason and is not verified by the platform."
          >
            <ThemeIcon size="xs" variant="subtle" color="gray">
              <IconInfoCircle size={13} />
            </ThemeIcon>
          </Tooltip>
        </Group>
        {connectClientName && (
          <Text size="xs" c="dimmed">
            Client: {connectClientName}
          </Text>
        )}

        {scopes.length === 0 ? (
          <Text size="xs" c="dimmed" fs="italic">
            No permissions requested — the app connects without account access.
          </Text>
        ) : (
          <>
            {sensitiveScopes.length > 0 && (
              <Stack gap={8} data-testid="connect-scopes-sensitive-group">
                <Group gap={6}>
                  <IconAlertTriangle size={14} color="var(--mantine-color-orange-6)" />
                  <Text size="sm" fw={600} c="orange">
                    Sensitive permissions ({sensitiveScopes.length})
                  </Text>
                  <Tooltip
                    multiline
                    w={280}
                    label="Elevated-risk permissions — these let the app spend the user's Buzz, read the user's balance or private data (incl. email), or write data other users see. Review each justification carefully; approval is blocked unless every one is justified."
                  >
                    <ThemeIcon size="xs" variant="subtle" color="orange">
                      <IconInfoCircle size={13} />
                    </ThemeIcon>
                  </Tooltip>
                </Group>
                {sensitiveScopes.map((s) => (
                  <ConnectScopeRow
                    key={s.bit}
                    scopeKey={s.key}
                    label={s.label}
                    sensitive
                    justifications={justifications}
                  />
                ))}
              </Stack>
            )}

            <Group gap={6}>
              <IconKey size={14} />
              <Text size="sm" fw={600}>
                Permissions ({normalScopes.length})
              </Text>
            </Group>
            {normalScopes.length === 0 ? (
              <Text size="xs" c="dimmed" fs="italic">
                No non-sensitive permissions requested.
              </Text>
            ) : (
              <Stack gap={8} data-testid="connect-scopes-normal-group">
                {normalScopes.map((s) => (
                  <ConnectScopeRow
                    key={s.bit}
                    scopeKey={s.key}
                    label={s.label}
                    justifications={justifications}
                  />
                ))}
              </Stack>
            )}
          </>
        )}
      </Stack>
    </Card>
  );
}

function ConnectScopeRow({
  scopeKey,
  label,
  sensitive = false,
  justifications,
}: {
  scopeKey: string;
  label: string;
  sensitive?: boolean;
  justifications?: Record<string, string> | null;
}) {
  const raw = justifications?.[scopeKey];
  const justification = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
  return (
    <Stack gap={2} data-testid={`connect-scope-row-${scopeKey}`}>
      <Group gap={8} align="flex-start" wrap="nowrap">
        <ThemeIcon size="xs" variant="subtle" color={sensitive ? 'orange' : 'blue'}>
          <IconKey size={12} />
        </ThemeIcon>
        <Text size="sm" fw={600} style={{ fontFamily: 'ui-monospace, monospace' }}>
          {scopeKey}
        </Text>
        {sensitive && <SensitiveScopeBadge />}
        {label && (
          <Text size="xs" c="dimmed">
            {label}
          </Text>
        )}
      </Group>
      {justification ? (
        <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
          <Text span fw={600} c="dimmed">
            Why:{' '}
          </Text>
          {justification}
        </Text>
      ) : (
        <Text size="xs" c="dimmed" fs="italic">
          No justification provided
        </Text>
      )}
    </Stack>
  );
}
