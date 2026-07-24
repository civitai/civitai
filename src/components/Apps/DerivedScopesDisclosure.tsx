import { Alert, Collapse, Group, Stack, Text, Textarea, UnstyledButton } from '@mantine/core';
import { useDisclosure, useReducedMotion } from '@mantine/hooks';
import { IconAlertTriangle, IconChevronRight } from '@tabler/icons-react';
import { useState } from 'react';
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
 * creation), so this surface NO LONGER lets the author re-pick them.
 *
 * SENSITIVE-ONLY JUSTIFICATION MODEL — kills the wall-of-inputs:
 *   - SENSITIVE scopes (money / private data / cross-user writes — the shared
 *     `isSensitiveTokenScope` predicate, the SAME set the server approval gate
 *     `assertConnectSensitiveScopesJustified` enforces) each render with the
 *     `SensitiveScopeBadge` + a REQUIRED justification input.
 *   - NON-SENSITIVE scopes collapse behind an "Other permissions (N)" disclosure as
 *     a READ-ONLY list — no inputs, never required.
 *
 * An empty mask (a client that requests no scopes) renders a clear "no scopes" state
 * with no inputs — a valid submission. The justification map is keyed by the
 * TokenScope enum-key (via `tokenScopeKeyByBit`), matching the server-side
 * `scopeJustifications` contract.
 *
 * SUBTLE MOTION (reuses the repo's Mantine `Transition`/`Collapse` + `useReducedMotion`
 * — no new dep): the sensitive inputs fade in as a group, the "Other permissions"
 * list animates open/closed, and a keyboard-focusable toggle drives it. Everything
 * degrades to a static render under `prefers-reduced-motion`.
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
  forceShowErrors = false,
}: {
  /** The derived requested-scope mask (= the selected client's `allowedScopes`). */
  requestedScopes: number;
  /** enum-key → rationale (prefilled + edited here). */
  justifications: Record<string, string>;
  onJustificationChange: (key: string, text: string) => void;
  disabled?: boolean;
  /** Optional lead-in copy above the scope list. */
  intro?: React.ReactNode;
  /**
   * When true, surface the "required" error on every empty SENSITIVE justification
   * immediately (the parent flips this on a blocked advance/submit). Otherwise an
   * error shows only after the input is touched.
   */
  forceShowErrors?: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const [otherOpened, { toggle: toggleOther }] = useDisclosure(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const scopes = tokenScopeMaskToList(requestedScopes);
  const sensitive = scopes.filter((s) => isSensitiveTokenScope(s.bit));
  const nonSensitive = scopes.filter((s) => !isSensitiveTokenScope(s.bit));

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
        <Stack gap="sm" data-testid="apps-offsite-scope-readonly">
          {sensitive.length > 0 && (
            <div data-testid="apps-offsite-justifications">
              <Stack gap="sm">
                <Group gap={6} wrap="nowrap">
                  <IconAlertTriangle size={14} color="var(--mantine-color-orange-6)" />
                  <Text size="sm" fw={600} c="orange">
                    Sensitive permissions ({sensitive.length})
                  </Text>
                </Group>
                <Text size="xs" c="dimmed">
                  These are elevated-risk — tell us why your app needs each one. A moderator
                  can only approve the listing once every sensitive permission is justified.
                </Text>
                {sensitive.map(({ bit, key, label }) => {
                  const justificationKey = tokenScopeKeyByBit(bit) ?? String(bit);
                  const text = justifications[justificationKey] ?? '';
                  const isEmpty = text.trim().length === 0;
                  const showError = isEmpty && (forceShowErrors || touched[justificationKey]);
                  return (
                    <div key={bit}>
                      <Group gap={8} wrap="nowrap" align="center" mb={4}>
                        <Text
                          size="sm"
                          fw={600}
                          style={{ fontFamily: 'ui-monospace, monospace' }}
                        >
                          {key}
                        </Text>
                        <SensitiveScopeBadge />
                        {label && (
                          <Text size="xs" c="dimmed">
                            {label}
                          </Text>
                        )}
                      </Group>
                      <Textarea
                        aria-label={`Why your app needs ${label || key}`}
                        placeholder="Explain why your app needs this permission…"
                        autosize
                        minRows={2}
                        maxRows={4}
                        withAsterisk
                        required
                        value={text}
                        onChange={(e) =>
                          onJustificationChange(justificationKey, e.currentTarget.value)
                        }
                        onBlur={() =>
                          setTouched((prev) => ({ ...prev, [justificationKey]: true }))
                        }
                        maxLength={SCOPE_JUSTIFICATION_MAX_LENGTH}
                        disabled={disabled}
                        error={showError ? 'A justification is required for this permission.' : undefined}
                        description={
                          showError ? undefined : `${text.length}/${SCOPE_JUSTIFICATION_MAX_LENGTH}`
                        }
                        data-testid={`apps-offsite-justification-${bit}`}
                      />
                    </div>
                  );
                })}
              </Stack>
            </div>
          )}

          {nonSensitive.length > 0 && (
            <div data-testid="apps-offsite-scope-other">
              <UnstyledButton
                onClick={toggleOther}
                aria-expanded={otherOpened}
                aria-controls="apps-offsite-scope-other-list"
                data-testid="apps-offsite-scope-other-toggle"
                style={{ width: '100%' }}
              >
                <Group gap={6} wrap="nowrap">
                  <IconChevronRight
                    size={14}
                    style={{
                      transition: reduceMotion ? undefined : 'transform 150ms ease',
                      transform: otherOpened ? 'rotate(90deg)' : undefined,
                    }}
                  />
                  <Text size="sm" fw={500}>
                    Other permissions ({nonSensitive.length})
                  </Text>
                  <Text size="xs" c="dimmed">
                    {otherOpened ? 'Hide' : 'Show'}
                  </Text>
                </Group>
              </UnstyledButton>
              <Collapse
                in={otherOpened}
                transitionDuration={reduceMotion ? 0 : 200}
                id="apps-offsite-scope-other-list"
                data-testid="apps-offsite-scope-other-list"
              >
                <Stack gap={6} pt="xs" pl={20}>
                  <Text size="xs" c="dimmed">
                    Standard permissions — no justification needed.
                  </Text>
                  {nonSensitive.map(({ bit, key, label }) => (
                    <Group key={bit} gap={8} wrap="nowrap" align="center">
                      <Text
                        size="sm"
                        fw={600}
                        style={{ fontFamily: 'ui-monospace, monospace' }}
                      >
                        {key}
                      </Text>
                      {(label || tokenScopeLabels[bit]) && (
                        <Text size="xs" c="dimmed">
                          {label || tokenScopeLabels[bit]}
                        </Text>
                      )}
                    </Group>
                  ))}
                </Stack>
              </Collapse>
            </div>
          )}
        </Stack>
      )}
    </Stack>
  );
}
