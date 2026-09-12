import { Group, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconKey } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { SensitiveScopeBadge } from '~/components/Apps/SensitiveScopeBadge';

/**
 * ConnectScopeRow — how ONE OAuth-connect scope looks, wherever it is shown.
 *
 * Lifted out of `ConnectScopesPanel` (the moderator review surface) so the PUBLIC
 * store-page disclosure (`ConnectScopesDisclosure`) renders a scope IDENTICALLY
 * rather than through a second hand-rolled renderer — in particular the
 * `SensitiveScopeBadge` emphasis, which is the part a viewer is meant to notice
 * and the part most likely to drift if it were spelled twice.
 *
 * 🔴 THE JUSTIFICATION IS A `children` SLOT, NOT A PROP, AND THAT IS THE POINT.
 * `connectScopeJustifications` is free text authored by the app owner; disclosing
 * it publicly is a SEPARATE exposure decision that has not been made (clawgate
 * #555 lists it as a non-goal). Because this row cannot render justification text
 * on its own, the public surface is structurally unable to leak it — it simply
 * passes no children. A `justifications` prop here would have made that a
 * convention the next caller could forget. The moderator panel supplies its own
 * justification block as children, so its DOM is unchanged by the extraction.
 *
 * Its own module rather than an export of `ConnectScopesPanel`, because component
 * tests mock that module wholesale — importing the row from it would make the row
 * disappear from any suite that stubs the panel.
 */
export function ConnectScopeRow({
  scopeKey,
  label,
  sensitive = false,
  children,
}: {
  /** The TokenScope enum-key, e.g. `ModelsRead`. Rendered verbatim, monospaced. */
  scopeKey: string;
  /** The human-readable label for the scope; falsy renders no label element. */
  label: string;
  sensitive?: boolean;
  /** Moderator-only detail rendered under the identity line. See the docblock. */
  children?: ReactNode;
}) {
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
      {children}
    </Stack>
  );
}
