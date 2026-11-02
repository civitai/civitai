import { Badge, Text, Tooltip } from '@mantine/core';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/** Hint shown under the permission preset picker. Presets themselves are unchanged. */
export const GENERATION_PRESET_HINT =
  'Generating (running jobs and spending Buzz) needs the "AI Services" or "Full Access" preset. Keys made with "Creator" or "Read Only" can’t generate.';

/**
 * Whether a key can run generation. A key with no scope (legacy) is treated as Full Access,
 * matching how requests are authorised (`tokenScope ?? TokenScope.Full`).
 */
export function canKeyGenerate(tokenScope: number | null | undefined): boolean {
  const scope = tokenScope ?? TokenScope.Full;
  return (scope & TokenScope.AIServicesWrite) !== 0;
}

export function GenerationPresetHint() {
  return (
    <Text size="xs" c="dimmed" mt={-4}>
      {GENERATION_PRESET_HINT}
    </Text>
  );
}

/** Small per-key marker: can this key run generation (has the "AI Services" write scope)? */
export function ApiKeyGenerationMarker({ tokenScope }: { tokenScope: number | null | undefined }) {
  const can = canKeyGenerate(tokenScope);
  return (
    <Tooltip
      multiline
      w={260}
      withArrow
      events={{ hover: true, focus: true, touch: true }}
      label={
        can
          ? 'This key has the "AI Services" write permission (ai:write:budgeted), so it can run generation.'
          : 'This key lacks the "AI Services" write permission (ai:write:budgeted), so generation requests are refused. Create a key with the "AI Services" or "Full Access" preset to generate.'
      }
    >
      <Badge
        size="sm"
        variant="outline"
        color={can ? 'teal' : 'gray'}
        tabIndex={0}
        data-testid="api-key-generation-marker"
        style={{ cursor: 'help' }}
      >
        {can ? 'Can generate' : 'Can’t generate'}
      </Badge>
    </Tooltip>
  );
}
