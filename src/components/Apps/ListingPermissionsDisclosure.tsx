import { Card, Group, Stack, Text, ThemeIcon, Title, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconInfoCircle, IconShieldCheck } from '@tabler/icons-react';
import { SensitiveScopeBadge } from '~/components/Apps/SensitiveScopeBadge';
import {
  groupListingPermissions,
  type ListingPermission,
} from '~/components/Apps/listingPermissions';

/**
 * The store detail page's permission disclosure — the ONE renderer for every listing shape.
 *
 * On-site apps (block scopes) and off-site connect apps (OAuth scopes) both arrive here as
 * `ListingPermission` rows (`listingPermissions.ts`), so both read the same way: plain-language
 * rows, no scope ids, the elevated-risk ones collected under "Sensitive permissions" ahead of
 * the rest, and each group in the same order. The grouping and the order live in
 * `groupListingPermissions`, not here; this component only lays the groups out.
 *
 * 🔴 RENDERS NOTHING FOR AN EMPTY LIST — not an empty box. On a store listing "no permissions"
 * is better said by the absence of the section than by a sentence nobody reads.
 *
 * The heading copy is the CALLER'S, because the honest sentence differs by shape: an on-site
 * app's scopes are what a moderator granted ("This app can…"), while a connect listing's are
 * what a moderator reviewed and not a promise about the sign-in screen
 * (`ConnectScopesDisclosure` owns that wording and why it is hedged).
 */
export function ListingPermissionsDisclosure({
  permissions,
  title,
  info,
  testId,
}: {
  permissions: ListingPermission[];
  title: string;
  /** Optional tooltip beside the heading. */
  info?: string;
  /** The section's `data-testid`. */
  testId: string;
}) {
  if (permissions.length === 0) return null;
  const { sensitive, other } = groupListingPermissions(permissions);

  return (
    <Card withBorder data-testid={testId}>
      <Group gap="xs" mb="sm" wrap="nowrap">
        <ThemeIcon variant="light" color="blue" size="sm" radius="xl">
          <IconShieldCheck size={14} />
        </ThemeIcon>
        <Title order={4}>{title}</Title>
        {info && (
          <Tooltip multiline w={300} label={info}>
            <ThemeIcon size="xs" variant="subtle" color="gray">
              <IconInfoCircle size={13} />
            </ThemeIcon>
          </Tooltip>
        )}
      </Group>
      <Stack gap="md">
        {sensitive.length > 0 && (
          <Stack gap="sm" data-testid="listing-permissions-sensitive-group">
            <Group gap={6} wrap="nowrap">
              <IconAlertTriangle size={14} color="var(--mantine-color-orange-6)" />
              <Text size="sm" fw={600} c="orange">
                Sensitive permissions ({sensitive.length})
              </Text>
            </Group>
            {sensitive.map((p) => (
              <PermissionRow key={p.id} permission={p} />
            ))}
          </Stack>
        )}
        {other.length > 0 && (
          <Stack gap="sm" data-testid="listing-permissions-other-group">
            {/* Only named when there is a sensitive group to tell it apart from. */}
            {sensitive.length > 0 && (
              <Text size="sm" fw={600}>
                Other permissions ({other.length})
              </Text>
            )}
            {other.map((p) => (
              <PermissionRow key={p.id} permission={p} />
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

function PermissionRow({ permission }: { permission: ListingPermission }) {
  const { id, title, detail, sensitive } = permission;
  return (
    <Group gap="sm" wrap="nowrap" align="flex-start" data-permission-row={id}>
      <ThemeIcon
        variant="light"
        color={sensitive ? 'orange' : 'green'}
        size="sm"
        radius="xl"
        mt={2}
      >
        {sensitive ? <IconAlertTriangle size={12} /> : <IconCheck size={12} />}
      </ThemeIcon>
      <Stack gap={2} style={{ minWidth: 0 }}>
        <Group gap="xs" wrap="wrap">
          <Text size="sm" fw={500}>
            {title}
          </Text>
          {sensitive && <SensitiveScopeBadge size="sm" />}
        </Group>
        {detail && (
          <Text size="xs" c="dimmed">
            {detail}
          </Text>
        )}
      </Stack>
    </Group>
  );
}
