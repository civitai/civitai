import { Badge, CopyButton, Group } from '@mantine/core';

const TEMPLATE_VARIABLES = [
  { name: 'systemPrompt', description: 'The judge system prompt' },
  { name: 'reviewPrompt', description: 'The judge review prompt' },
  { name: 'theme', description: 'The challenge theme' },
] as const;

export function TemplateVariableIndicators({ value }: { value: string }) {
  return (
    <Group gap={6}>
      {TEMPLATE_VARIABLES.map((v) => {
        const variable = `{{${v.name}}}`;
        const isUsed = value.includes(variable);
        return (
          <CopyButton key={v.name} value={variable}>
            {({ copied, copy }) => (
              <Badge
                variant="light"
                color={copied ? 'teal' : isUsed ? 'green' : 'gray'}
                size="xs"
                title={copied ? 'Copied!' : `${v.description} — click to copy`}
                style={{ cursor: 'pointer', textTransform: 'none' }}
                onClick={copy}
              >
                {copied ? 'Copied!' : variable}
              </Badge>
            )}
          </CopyButton>
        );
      })}
    </Group>
  );
}
