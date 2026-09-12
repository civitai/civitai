import { Badge, Group, Stack, Text } from '@mantine/core';
import { SensitiveScopeBadge } from '~/components/Apps/SensitiveScopeBadge';
import { isSensitiveBlockScope } from '~/shared/constants/block-scope.constants';
import { SCOPE_DESCRIPTIONS } from '~/server/services/blocks/scope-descriptions.constants';

/**
 * Renders a list of block scope ids as a badge + friendly-description list. Unknown scopes (not
 * in SCOPE_DESCRIPTIONS) render as a bare badge with an italic "(no description)" — keeping the
 * description map a soft contract so new scopes ship without breaking the UI.
 *
 * 🔴 THIS COMPONENT IS PRESENTATION ONLY AND MAKES NO CLAIM ABOUT WHICH SET IT IS HANDED.
 * ⚠️ The previous docstring said it was "shared by the install/manage modal … and the
 * /apps/activity panel so the two surfaces never drift". That guarantee was false and is DELETED
 * rather than restated: there are FOUR call sites and they are fed from THREE different sets, by
 * design —
 *
 *   - `src/pages/apps/activity.tsx` and `src/components/AppBlocks/AppPermissionsActivityDrawer.tsx`
 *     pass `listMyScopeGrants().scopes` = `manifest.scopes ∩ approved_scopes`.
 *   - `src/components/Apps/AppSettingsModal.tsx` passes `installConfig?.scopes ?? manifest.scopes
 *     ?? []` — that same intersection when `getInstallConfig` has resolved, but falling back to
 *     the RAW manifest on the Manage path when it has not. Pre-existing; not changed here.
 *   - `src/components/Apps/AppListingDetailBody.tsx` passes `detail.scopes` = RAW
 *     `approved_scopes`, with no intersection, deliberately — it is a PUBLIC pre-launch
 *     disclosure and over-disclosing the stale approval is the safe direction there. The
 *     reasoning lives at `src/server/services/blocks/app-listing.service.ts`; do not "align" it.
 *
 * So the set is the CALLER'S choice and each caller documents its own. A docstring here that
 * promised they agree would read as coverage while providing none.
 */
export function BlockScopeList({
  scopes,
  emptyLabel = "This app doesn't request any permissions — it only consumes data from the host-bridge postMessage protocol.",
}: {
  scopes: string[];
  emptyLabel?: string;
}) {
  if (scopes.length === 0) {
    return (
      <Text size="xs" c="dimmed" fs="italic">
        {emptyLabel}
      </Text>
    );
  }
  return (
    <Stack gap={4}>
      {scopes.map((scope) => {
        const desc = SCOPE_DESCRIPTIONS[scope];
        const sensitive = isSensitiveBlockScope(scope);
        return (
          <Group key={scope} gap="xs" wrap="nowrap" align="flex-start">
            <Badge size="sm" variant="light" color={sensitive ? 'orange' : undefined}>
              {scope}
            </Badge>
            {sensitive && <SensitiveScopeBadge size="sm" />}
            {desc ? (
              <Text size="xs" c="dimmed">
                {desc}
              </Text>
            ) : (
              <Text size="xs" c="dimmed" fs="italic">
                (no description)
              </Text>
            )}
          </Group>
        );
      })}
    </Stack>
  );
}
