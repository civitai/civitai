import { Badge, Text } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import { TokenScope, tokenScopePresetLabels } from '~/shared/constants/token-scope.constants';

const { AIServices, Full, Creator, ReadOnly } = tokenScopePresetLabels;

export const GENERATION_PRESET_HINT = `Generating (running jobs and spending Buzz) needs the "${AIServices}" or "${Full}" preset. Keys made with "${Creator}" or "${ReadOnly}" can\u2019t generate.`;

// null = legacy key, authorised as Full Access.
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

export function ApiKeyGenerationMarker({ tokenScope }: { tokenScope: number | null | undefined }) {
  const can = canKeyGenerate(tokenScope);
  const text = can ? 'Can generate' : 'Can\u2019t generate';
  const explanation = can
    ? `This key has the "${AIServices}" write permission (ai:write:budgeted), so it can run generation.`
    : `This key lacks the "${AIServices}" write permission (ai:write:budgeted), so generation requests may be refused. Create a key with the "${AIServices}" or "${Full}" preset to generate.`;
  return (
    <Tooltip
      multiline
      w={260}
      withArrow
      events={{ hover: true, focus: true, touch: true }}
      label={explanation}
    >
      <Badge
        size="sm"
        variant="outline"
        color={can ? 'teal' : 'gray'}
        tabIndex={0}
        role="note"
        aria-label={`${text}. ${explanation}`}
        data-testid="api-key-generation-marker"
        style={{ cursor: 'help' }}
      >
        {text}
      </Badge>
    </Tooltip>
  );
}
