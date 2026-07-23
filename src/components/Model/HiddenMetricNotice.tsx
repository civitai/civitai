import { Text, Tooltip } from '@mantine/core';
import { IconEyeOff } from '@tabler/icons-react';

export const HIDDEN_METRIC_MESSAGE =
  'This creator has hidden this metric. Creator Program members can hide theirs too.';

/**
 * Ranking-surface treatment for a metric a Creator Program member has hidden. The
 * model stays listed and the sort order still uses the real value server-side; only
 * the exposed number is replaced with this subtle notice + an invite for others to
 * do the same.
 *
 * Pass `withTooltip={false}` when an enclosing hover card already carries the message
 * (e.g. the model-page stat badges) so it isn't shown twice.
 */
export function HiddenMetricNotice({
  size = 14,
  withTooltip = true,
}: {
  size?: number;
  withTooltip?: boolean;
}) {
  const icon = (
    <Text
      component="span"
      c="dimmed"
      className="inline-flex items-center align-middle"
      lh={1}
      style={{ marginTop: -2 }}
    >
      <IconEyeOff size={size} />
    </Text>
  );

  if (!withTooltip) return icon;

  return (
    <Tooltip multiline w={220} withArrow label={HIDDEN_METRIC_MESSAGE}>
      {icon}
    </Tooltip>
  );
}
