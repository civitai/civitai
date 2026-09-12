import { Card, Group, Stack, Text, ThemeIcon, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle, IconKey } from '@tabler/icons-react';
import { ConnectScopeRow } from '~/components/Apps/ConnectScopeRow';
import {
  isSensitiveTokenScope,
  TokenScope,
  tokenScopeLabels,
} from '~/shared/constants/token-scope.constants';

/**
 * ConnectScopesDisclosure — the PUBLIC store-page enumeration of the account
 * permissions an OAuth-connect off-site listing will ask for, shown BEFORE the
 * viewer clicks Connect.
 *
 * 🔴 WHY THIS EXISTS: the store page already tells a viewer that an off-site app
 * "can connect to your Civitai account", and then said nothing about what it
 * would ask for — while the ON-SITE surface enumerates its approved scopes in
 * full (#4761). So the surface granting the WEAKER capability disclosed more than
 * the one granting real account access. Measured in production when this shipped:
 * of the listings carrying a connect client, the requested masks included
 * `UserRead` (profile, settings & email), `BuzzRead` (balance & history),
 * `AIServicesWrite` (Buzz spend) and in one case `VaultRead` (the user's private
 * model vault) — none of it disclosed anywhere the viewer could see it.
 *
 * 🔴 IT RENDERS THE SHARED `ConnectScopeRow`, NOT A SECOND RENDERER. The
 * sensitive-first ordering and the `SensitiveScopeBadge` emphasis therefore read
 * identically here and on the moderator review surface (`ConnectScopesPanel`).
 * That is a requirement, not a tidiness preference: two spellings of "this
 * permission is elevated-risk" drift, and the public one is the one nobody
 * reviews.
 *
 * 🔴 IT CANNOT DISCLOSE `connectScopeJustifications`, BY CONSTRUCTION. That text
 * is authored by the app owner and publishing it is a separate exposure decision
 * that has not been made. This component takes no justifications prop and the
 * shared row cannot render the text without children, so the omission is
 * structural rather than a convention someone later forgets.
 *
 * 🔴 NOT the mutually-exclusive off-site pair. `shouldShowOffsiteDisclosure` and
 * `shouldShowConnectCapability` are exact complements over one domain and their
 * never-both-never-neither invariant is pinned in
 * `__tests__/appListingDetailView.test.ts`. This is a THIRD surface that follows
 * the connect-capability sentence and enumerates it; do not fold it into either
 * predicate, exactly as the on-site scopes section must not be folded in.
 *
 * Rendered only when there is something to disclose — the caller guards on
 * `length > 0`, matching the on-site section, so a listing that requests nothing
 * gets no section rather than a reassuring empty box.
 */
export function ConnectScopesDisclosure({ scopes }: { scopes: string[] }) {
  // Resolve enum-key → bit through the SHARED table so the label and the
  // sensitivity verdict can never fork from the hub's OAuth consent screen. An
  // unrecognised key is DROPPED rather than rendered bare: the wire format is a
  // key list, so a key this build does not know is a scope it cannot describe,
  // and a monospaced identifier with no label and no risk verdict is worse than
  // silence on a surface whose whole job is to inform.
  const resolved = scopes
    .map((key) => ({ key, bit: TokenScope[key as keyof typeof TokenScope] }))
    .filter((s): s is { key: string; bit: number } => typeof s.bit === 'number' && s.bit > 0)
    .map((s) => ({ ...s, label: tokenScopeLabels[s.bit] ?? '' }))
    .sort((a, b) => a.bit - b.bit);

  const sensitiveScopes = resolved.filter((s) => isSensitiveTokenScope(s.bit));
  const normalScopes = resolved.filter((s) => !isSensitiveTokenScope(s.bit));

  if (resolved.length === 0) return null;

  return (
    <Card withBorder p="sm" data-testid="connect-scopes-disclosure">
      <Stack gap="xs">
        <Group gap={6}>
          <IconKey size={14} />
          <Text size="sm" fw={600}>
            Permissions this app will request ({resolved.length})
          </Text>
          <Tooltip
            multiline
            w={300}
            label="If you connect this app, it will ask you to sign in and approve these permissions. You can review them again on the Civitai sign-in screen, and you can disconnect the app at any time."
          >
            <ThemeIcon size="xs" variant="subtle" color="gray">
              <IconInfoCircle size={13} />
            </ThemeIcon>
          </Tooltip>
        </Group>

        {sensitiveScopes.length > 0 && (
          <Stack gap={8} data-testid="connect-scopes-disclosure-sensitive-group">
            <Group gap={6}>
              <IconAlertTriangle size={14} color="var(--mantine-color-orange-6)" />
              <Text size="sm" fw={600} c="orange">
                Sensitive permissions ({sensitiveScopes.length})
              </Text>
              <Tooltip
                multiline
                w={280}
                label="Elevated-risk permissions — these let the app spend your Buzz, read your balance or private data (including your email), or write data other users see."
              >
                <ThemeIcon size="xs" variant="subtle" color="orange">
                  <IconInfoCircle size={13} />
                </ThemeIcon>
              </Tooltip>
            </Group>
            {sensitiveScopes.map((s) => (
              <ConnectScopeRow key={s.bit} scopeKey={s.key} label={s.label} sensitive />
            ))}
          </Stack>
        )}

        {normalScopes.length > 0 && (
          <Stack gap={8} data-testid="connect-scopes-disclosure-normal-group">
            {sensitiveScopes.length > 0 && (
              <Group gap={6}>
                <IconKey size={14} />
                <Text size="sm" fw={600}>
                  Other permissions ({normalScopes.length})
                </Text>
              </Group>
            )}
            {normalScopes.map((s) => (
              <ConnectScopeRow key={s.bit} scopeKey={s.key} label={s.label} />
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
