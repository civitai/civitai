import { Badge, Group, Tooltip } from '@mantine/core';
import type { MultiSelectProps } from '@mantine/core';
import { IconCheck, IconShield } from '@tabler/icons-react';
import { useMaybeAppContext } from '~/providers/AppProvider';
import {
  isBaseModelSfwOnly,
  isEcosystemNsfwRestricted,
  SFW_ONLY_TOOLTIP,
} from '~/components/SfwOnlyBadge/sfw-only.utils';

type SfwOnlyBadgeProps = {
  baseModel?: string | null;
  /** The generator picker lists ecosystems: marked only when every one of them is SFW only. */
  ecosystemIds?: number[];
  className?: string;
};

// civitai.red only: .com (green) is SFW everywhere, so the badge would say nothing there.
export function SfwOnlyBadge({ baseModel, ecosystemIds, className }: SfwOnlyBadgeProps) {
  // No provider (an embed or a bare test mount): show nothing rather than crash the tree.
  const domain = useMaybeAppContext()?.domain;
  const sfwOnly = ecosystemIds
    ? ecosystemIds.length > 0 && ecosystemIds.every(isEcosystemNsfwRestricted)
    : isBaseModelSfwOnly(baseModel);
  if (!domain || domain.green || !sfwOnly) return null;

  return (
    <Tooltip label={SFW_ONLY_TOOLTIP} withArrow multiline w={220}>
      <Badge
        size="xs"
        color="green"
        variant="light"
        leftSection={<IconShield size={12} />}
        className={className}
        style={{ flexShrink: 0 }}
        data-testid="sfw-only-badge"
      >
        SFW only
      </Badge>
    </Tooltip>
  );
}

// Base model filter option: the name, with the badge right-aligned.
export const renderBaseModelOption: MultiSelectProps['renderOption'] = ({ option, checked }) => (
  <Group gap="xs" wrap="nowrap" justify="space-between" w="100%">
    <Group gap={6} wrap="nowrap">
      {checked && <IconCheck size={14} />}
      <span>{option.label}</span>
    </Group>
    <SfwOnlyBadge baseModel={option.value} />
  </Group>
);
