import { Badge, Checkbox, Group, Stack, Text } from '@mantine/core';
import { SensitiveScopeBadge } from '~/components/Apps/SensitiveScopeBadge';
import { buildScopeOptions, toggleScope } from '~/components/Apps/blockScopeSelection';

/**
 * Reusable scope checklist for the App-manifest editor. Renders the known block
 * scopes (from `BLOCK_SCOPE_TO_OAUTH_BIT`) as a checkbox each, showing the
 * friendly description and a "Sensitive" warning badge for elevated-risk scopes
 * (reusing `SensitiveScopeBadge` / `isSensitiveBlockScope`). Replaces the old
 * free-text scopes textarea so a dev can only pick from the real vocabulary.
 *
 * An existing manifest that declares a legacy/unknown scope (not in the current
 * registry) still shows it as a selected, removable row (marked "legacy") — it is
 * never silently dropped. Selection drives `patch.scopes`; the server re-validates
 * the set against the app's OAuth ceiling on save (this is advisory only).
 *
 * Each checkbox's accessible name is exactly the scope id, so the badge/description
 * live alongside (not inside) the label.
 */
export function BlockScopeSelector({
  value,
  onChange,
}: {
  value: string[];
  onChange: (scopes: string[]) => void;
}) {
  const options = buildScopeOptions(value);
  return (
    <Stack gap="sm" data-testid="block-scope-selector">
      {options.map((opt) => {
        const checked = value.includes(opt.scope);
        return (
          <Stack key={opt.scope} gap={2}>
            <Group gap="xs" wrap="nowrap" align="center">
              <Checkbox
                checked={checked}
                onChange={(e) => onChange(toggleScope(value, opt.scope, e.currentTarget.checked))}
                label={opt.scope}
                styles={{
                  label: {
                    fontFamily: 'ui-monospace, monospace',
                    color: opt.sensitive ? 'var(--mantine-color-orange-7)' : undefined,
                  },
                }}
              />
              {opt.sensitive && <SensitiveScopeBadge size="xs" />}
              {!opt.known && (
                <Badge size="xs" color="gray" variant="outline">
                  legacy
                </Badge>
              )}
            </Group>
            <Text size="xs" c="dimmed" ml={28}>
              {opt.description ??
                (opt.known ? '(no description)' : 'Not in the current scope registry.')}
            </Text>
          </Stack>
        );
      })}
    </Stack>
  );
}
