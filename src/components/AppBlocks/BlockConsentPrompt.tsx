import { Alert, Button, List, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconShieldLock } from '@tabler/icons-react';
import { useState } from 'react';
import { SCOPE_DESCRIPTIONS } from '~/server/services/blocks/scope-descriptions.constants';
import { trpc } from '~/utils/trpc';

interface BlockConsentPromptProps {
  appBlockId: string;
  blockName?: string;
  /** The consent-gated scopes the app declares but the viewer hasn't granted. */
  missingScopes: string[];
  /** Re-fetch the block token after a grant so it carries the new scopes. */
  onGranted: () => void;
}

/**
 * A6 (audit HIGH / design-gaps C2) — minimal re-consent surface.
 *
 * When a block's approved manifest declares scopes the viewer hasn't granted
 * (e.g. a v2 added `ai:write:budgeted`), the block-token endpoint mints only
 * the granted subset and flags `needsConsent`. This prompt lists the new scopes
 * and, on accept, records the grant via `blocks.grantScopes` then triggers a
 * token refresh so the block can use the newly-granted capabilities.
 *
 * This is the consent disclosure C2 requires — NOT the read-only "Apps &
 * permissions" tab (which is post-hoc reflection, not a grant gate).
 */
export function BlockConsentPrompt({
  appBlockId,
  blockName,
  missingScopes,
  onGranted,
}: BlockConsentPromptProps) {
  const [error, setError] = useState<string | null>(null);
  const grant = trpc.blocks.grantScopes.useMutation({
    onSuccess: () => {
      setError(null);
      onGranted();
    },
    onError: (e) => setError(e.message),
  });

  if (missingScopes.length === 0) return null;

  return (
    <Alert
      color="yellow"
      variant="light"
      icon={
        <ThemeIcon color="yellow" variant="light" size="md">
          <IconShieldLock size={18} />
        </ThemeIcon>
      }
      title={`${blockName ?? 'This app'} is requesting new permissions`}
    >
      <Stack gap="xs">
        <Text size="sm">
          A newer version of this app needs permissions you haven&apos;t granted yet. Review and
          approve to let it use them:
        </Text>
        <List size="sm" spacing={2}>
          {missingScopes.map((scope) => (
            <List.Item key={scope}>
              <Text component="span" fw={600}>
                {scope}
              </Text>
              {SCOPE_DESCRIPTIONS[scope] ? ` — ${SCOPE_DESCRIPTIONS[scope]}` : null}
            </List.Item>
          ))}
        </List>
        {error ? (
          <Text size="xs" c="red">
            {error}
          </Text>
        ) : null}
        <Button
          size="xs"
          color="yellow"
          loading={grant.isPending}
          onClick={() => grant.mutate({ appBlockId, scopes: missingScopes })}
        >
          Grant permissions
        </Button>
      </Stack>
    </Alert>
  );
}
