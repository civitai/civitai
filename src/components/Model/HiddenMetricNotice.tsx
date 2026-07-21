import { Text, Tooltip } from '@mantine/core';
import { IconEyeOff } from '@tabler/icons-react';

/**
 * Ranking-surface treatment for a metric a Creator Program member has hidden. The
 * model stays listed and the sort order still uses the real value server-side; only
 * the exposed number is replaced with this subtle notice + an invite for others to
 * do the same.
 */
export function HiddenMetricNotice({ size = 14 }: { size?: number }) {
  return (
    <Tooltip
      multiline
      w={220}
      withArrow
      label="This creator has hidden this metric. Creator Program members can hide theirs too."
    >
      <Text component="span" c="dimmed" className="inline-flex items-center" lh={1}>
        <IconEyeOff size={size} />
      </Text>
    </Tooltip>
  );
}
