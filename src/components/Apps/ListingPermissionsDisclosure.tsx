import { Fragment, useId, type ReactNode } from 'react';
import { Card, Divider, Group, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import {
  IconAlertTriangle,
  IconCheck,
  IconInfoCircle,
  IconPointFilled,
  IconShieldCheck,
} from '@tabler/icons-react';
import { SensitiveScopeBadge } from '~/components/Apps/SensitiveScopeBadge';
import {
  groupListingPermissions,
  PERMISSION_GROUP_LABELS,
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

  return (
    <Card withBorder data-testid={testId}>
      <Group gap="xs" mb="sm" wrap="nowrap">
        <IconShieldCheck size={22} aria-hidden />
        <Title order={4}>{title}</Title>
        {info && (
          <Tooltip multiline w={300} label={info}>
            <ThemeIcon size="xs" variant="subtle" color="gray">
              <IconInfoCircle size={13} />
            </ThemeIcon>
          </Tooltip>
        )}
      </Group>
      <ListingPermissionGroups permissions={permissions} />
    </Card>
  );
}

/**
 * `check` marks a permission the app HAS (store listing, settings, grants). `neutral` is for a
 * permission not yet given — a consent prompt's whole list, or one row of a grant list — where a
 * green check would read as "already allowed".
 */
export type PermissionRowMarker = 'check' | 'neutral';

/**
 * The grouped rows alone, for an end-user surface with its own heading: the launch consent
 * prompt, the app details modal, the install/manage settings modal, and the grant-management
 * list in the permissions drawer and /apps/activity. `renderDetail` adds a caller's per-permission
 * content (a revoke control, a consent note) under a row, keyed by the permission's id.
 */
export function ListingPermissionGroups({
  permissions,
  renderDetail,
  revokedIds,
  notGrantedIds,
  marker = 'check',
}: {
  permissions: ListingPermission[];
  renderDetail?: (id: string) => ReactNode;
  /** Permissions the viewer withdrew: struck through and greyed, never dropped. */
  revokedIds?: string[];
  /** Permissions the viewer has not given yet: the `neutral` marker whatever `marker` says. */
  notGrantedIds?: string[];
  marker?: PermissionRowMarker;
}) {
  const groupId = useId();
  const markerFor = (id: string): PermissionRowMarker =>
    notGrantedIds?.includes(id) ? 'neutral' : marker;
  const { sensitive, other } = groupListingPermissions(permissions);
  const labelled = sensitive.length > 0 && other.length > 0;
  return (
    <Stack gap="md">
      {sensitive.length > 0 && (
        <Stack
          gap="sm"
          data-testid="listing-permissions-sensitive-group"
          role={labelled ? 'group' : undefined}
          aria-labelledby={labelled ? `${groupId}-sensitive` : undefined}
        >
          <Group gap={6} wrap="nowrap">
            <IconAlertTriangle size={14} color="var(--mantine-color-orange-6)" />
            <Text id={`${groupId}-sensitive`} size="sm" fw={600} c="orange">
              {PERMISSION_GROUP_LABELS.sensitive} ({sensitive.length})
            </Text>
          </Group>
          {sensitive.map((p, i) => (
            <Fragment key={p.id}>
              {i > 0 && <Divider />}
              <PermissionRow
                permission={p}
                extra={renderDetail?.(p.id)}
                revoked={revokedIds?.includes(p.id)}
                marker={markerFor(p.id)}
              />
            </Fragment>
          ))}
        </Stack>
      )}
      {other.length > 0 && (
        <Stack
          gap="sm"
          data-testid="listing-permissions-other-group"
          role={labelled ? 'group' : undefined}
          aria-labelledby={labelled ? `${groupId}-other` : undefined}
        >
          {/* Only named when there is a sensitive group to tell it apart from. */}
          {labelled && (
            <Text id={`${groupId}-other`} size="sm" fw={600}>
              {PERMISSION_GROUP_LABELS.other} ({other.length})
            </Text>
          )}
          {other.map((p, i) => (
            <Fragment key={p.id}>
              {i > 0 && <Divider />}
              <PermissionRow
                permission={p}
                extra={renderDetail?.(p.id)}
                revoked={revokedIds?.includes(p.id)}
                marker={markerFor(p.id)}
              />
            </Fragment>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function PermissionRow({
  permission,
  extra,
  revoked = false,
  marker,
}: {
  permission: ListingPermission;
  extra?: ReactNode;
  revoked?: boolean;
  marker: PermissionRowMarker;
}) {
  const { id, title, detail, sensitive } = permission;
  return (
    <Group
      gap="sm"
      wrap="nowrap"
      align="flex-start"
      data-permission-row={id}
      data-revoked={revoked ? 'true' : undefined}
    >
      <ThemeIcon
        variant="light"
        color={revoked ? 'gray' : sensitive ? 'orange' : marker === 'check' ? 'green' : 'gray'}
        size="sm"
        radius="xl"
        mt={2}
      >
        {sensitive ? (
          <IconAlertTriangle size={12} />
        ) : marker === 'check' ? (
          <IconCheck size={12} />
        ) : (
          <IconPointFilled size={12} />
        )}
      </ThemeIcon>
      <Stack gap={2} style={{ minWidth: 0 }}>
        <Group gap="xs" wrap="wrap">
          <Text
            size="sm"
            fw={500}
            td={revoked ? 'line-through' : undefined}
            data-testid="permission-title"
            c={revoked ? 'dimmed' : undefined}
          >
            {title}
          </Text>
          {sensitive && <SensitiveScopeBadge size="sm" />}
        </Group>
        {detail && (
          <Text size="xs" c="dimmed">
            {detail}
          </Text>
        )}
        {extra}
      </Stack>
    </Group>
  );
}
