import { Alert, Group, Stack, Text, Textarea } from '@mantine/core';
import { SensitiveScopeBadge } from '~/components/Apps/SensitiveScopeBadge';
import {
  SCOPE_JUSTIFICATION_MAX_LENGTH,
  isSensitiveTokenScope,
  tokenScopeKeyByBit,
  tokenScopeLabels,
  tokenScopeMaskToList,
} from '~/shared/constants/token-scope.constants';

/**
 * DerivedScopesDisclosure — the AUTHOR-facing scope surface for the external-app
 * submit + edit wizards (W13). The listing's requested scopes are AUTO-DERIVED from
 * the selected OAuth client's `allowedScopes` (the client already declares them at
 * creation), so this surface NO LONGER lets the author re-pick them — it renders the
 * derived scope set READ-ONLY (with the shared `SensitiveScopeBadge` so sensitive
 * scopes stay prominent) and keeps ONLY the per-scope justification inputs (the
 * moderator-review + agentic scope-trace-verify signal the client-creation flow does
 * not capture).
 *
 * `requestedScopes` is the derived mask (= the client's `allowedScopes`). An empty
 * mask (a client that requests no scopes) renders a clear "no scopes" state with no
 * justification inputs — a valid submission. The justification map is keyed by the
 * TokenScope enum-key (via `tokenScopeKeyByBit`), matching the server-side
 * `scopeJustifications` contract.
 *
 * The SERVER is authoritative: it re-snapshots `requestedScopes` from the client's
 * CURRENT `allowedScopes` at submit time, so this display is disclosure/UX only.
 */
export function DerivedScopesDisclosure({
  requestedScopes,
  justifications,
  onJustificationChange,
  disabled = false,
  intro,
}: {
  /** The derived requested-scope mask (= the selected client's `allowedScopes`). */
  requestedScopes: number;
  /** enum-key → rationale (prefilled + edited here). */
  justifications: Record<string, string>;
  onJustificationChange: (key: string, text: string) => void;
  disabled?: boolean;
  /** Optional lead-in copy above the scope list. */
  intro?: React.ReactNode;
}) {
  const scopes = tokenScopeMaskToList(requestedScopes);

  return (
    <Stack gap="xs" data-testid="apps-offsite-scope-disclosure">
      <div>
        <Text size="sm" fw={500}>
          Scopes this app requests
        </Text>
        <Text size="xs" c="dimmed">
          {intro ??
            "These are your OAuth app's allowed scopes — users grant them when they connect. They're derived from the app itself and can't be changed here."}
        </Text>
      </div>

      {scopes.length === 0 ? (
        <Alert color="gray" variant="light" data-testid="apps-offsite-scope-empty">
          <Text size="sm">
            This OAuth app requests no scopes — it connects without account access.
          </Text>
        </Alert>
      ) : (
        <>
          <Stack gap={6} data-testid="apps-offsite-scope-readonly">
            {scopes.map(({ bit, key, label }) => (
              <Group key={bit} gap={8} wrap="nowrap" align="center">
                <Text size="sm" fw={600} style={{ fontFamily: 'ui-monospace, monospace' }}>
                  {key}
                </Text>
                {isSensitiveTokenScope(bit) && <SensitiveScopeBadge />}
                {label && (
                  <Text size="xs" c="dimmed">
                    {label}
                  </Text>
                )}
              </Group>
            ))}
          </Stack>

          <Stack gap="sm" data-testid="apps-offsite-justifications">
            <Text size="sm" fw={500}>
              Why do you need each scope? (optional, helps review)
            </Text>
            {scopes.map(({ bit, key, label }) => {
              const justificationKey = tokenScopeKeyByBit(bit) ?? String(bit);
              const text = justifications[justificationKey] ?? '';
              return (
                <Textarea
                  key={bit}
                  label={label || tokenScopeLabels[bit] || key}
                  placeholder="Explain why your app needs this scope…"
                  autosize
                  minRows={2}
                  maxRows={4}
                  value={text}
                  onChange={(e) => onJustificationChange(justificationKey, e.currentTarget.value)}
                  maxLength={SCOPE_JUSTIFICATION_MAX_LENGTH}
                  disabled={disabled}
                  description={`${text.length}/${SCOPE_JUSTIFICATION_MAX_LENGTH}`}
                  data-testid={`apps-offsite-justification-${bit}`}
                />
              );
            })}
          </Stack>
        </>
      )}
    </Stack>
  );
}
