import { Group, Text } from '@mantine/core';

interface ProgressLegendDotProps {
  color: string;
  count: number;
  label: string;
  /** Override color with a dynamic CSS value (e.g. for hover transitions). */
  dynamicColor?: string;
}

/** Small colored dot + label used in the segmented progress bar legend. */
export function ProgressLegendDot({ color, count, label, dynamicColor }: ProgressLegendDotProps) {
  return (
    <Group gap={4}>
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: dynamicColor ?? `var(--mantine-color-${color}-6)`,
          transition: dynamicColor ? 'background-color 0.3s ease' : undefined,
        }}
      />
      <Text size="xs" c="dimmed">
        {count} {label}
      </Text>
    </Group>
  );
}
