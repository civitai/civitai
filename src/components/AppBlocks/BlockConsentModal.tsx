import { Button, Group, List, Modal, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconShieldLock } from '@tabler/icons-react';
import { useState } from 'react';
import { SensitiveScopeBadge } from '~/components/Apps/SensitiveScopeBadge';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { isSensitiveBlockScope } from '~/shared/constants/block-scope.constants';
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
 */
export default function BlockConsentModal({
  appBlockId,
  blockName,
  missingScopes,
  onGranted,
}: BlockConsentModalProps) {
  const dialog = useDialogContext();
  const [error, setError] = useState<string | null>(null);
  const grant = trpc.blocks.grantScopes.useMutation({
    onSuccess: () => {
      setError(null);
      onGranted();
      dialog.onClose();
    },
    onError: (e) => setError(e.message),
  });

  return (
    <Modal {...dialog} withCloseButton={false} title={`${blockName ?? 'This app'} needs permission`}>
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
            onClick={() => grant.mutate({ appBlockId, scopes: missingScopes })}
          >
            Allow
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
