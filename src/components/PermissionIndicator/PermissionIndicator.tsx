import { Box, Group, GroupProps, List, Popover, Text, Tooltip, TooltipProps } from '@mantine/core';
import { CommercialUse } from '@prisma/client';
import {
  IconBrushOff,
  IconCheck,
  IconExchangeOff,
  IconPhotoOff,
  IconRotate2,
  IconShoppingCartOff,
  IconUserCheck,
  IconX,
} from '@tabler/icons';
import React from 'react';

export const PermissionIndicator = ({ permissions, size = 20, spacing = 2, ...props }: Props) => {
  const { allowNoCredit, allowCommercialUse, allowDerivatives, allowDifferentLicense } =
    permissions;
  const canSellImages =
    allowCommercialUse === 'Image' ||
    allowCommercialUse === 'Rent' ||
    allowCommercialUse === 'Sell';
  const canRent = allowCommercialUse === 'Rent' || allowCommercialUse === 'Sell';
  const canSell = allowCommercialUse === 'Sell';

  const explanation = {
    'Use the model without crediting the creator': allowNoCredit,
    'Sell images they generate': canSellImages,
    'Run on services that generate images for money': canRent,
    'Share merges using this model': allowDerivatives,
    'Sell this model or merges using this model': canSell,
    'Have different permissions when sharing merges': allowDifferentLicense,
  };
  const iconProps = { size, stroke: 1.5 };
  const icons = [
    !allowNoCredit && { label: 'Creator credit required', icon: <IconUserCheck {...iconProps} /> },
    !canSellImages && { label: 'No selling images', icon: <IconPhotoOff {...iconProps} /> },
    !canRent && { label: 'No generation services', icon: <IconBrushOff {...iconProps} /> },
    !canSell && { label: 'No selling models', icon: <IconShoppingCartOff {...iconProps} /> },
    !allowDerivatives && { label: 'No sharing merges', icon: <IconExchangeOff {...iconProps} /> },
    !allowDifferentLicense && {
      label: 'Same permissions required',
      icon: <IconRotate2 {...iconProps} />,
    },
  ].filter(Boolean) as { label: string; icon: React.ReactNode }[];
  return (
    <Popover withArrow>
      <Popover.Target>
        <Group spacing={spacing} sx={{ cursor: 'pointer' }} noWrap {...props}>
          {icons.map(({ label, icon }, i) => (
            <Tooltip key={i} label={label} withArrow withinPortal position="top">
              <Box sx={(theme) => ({ color: theme.colors.gray[5] })}>{icon}</Box>
            </Tooltip>
          ))}
        </Group>
      </Popover.Target>
      <Popover.Dropdown>
        <Text weight={500}>This model permits users to:</Text>
        <List
          size="xs"
          styles={{
            itemIcon: { marginRight: 4, paddingTop: 2 },
          }}
        >
          {Object.entries(explanation).map(([permission, allowed], i) => (
            <List.Item
              key={i}
              styles={(theme) => ({
                itemIcon: { color: theme.colors.red[4] },
              })}
              icon={
                allowed ? (
                  <IconCheck style={{ color: 'green' }} size={12} stroke={4} />
                ) : (
                  <IconX style={{ color: 'red' }} size={12} stroke={3} />
                )
              }
            >
              {permission}
            </List.Item>
          ))}
        </List>
      </Popover.Dropdown>
    </Popover>
  );
};

type Props = {
  permissions: Permissions;
  size?: number;
} & Omit<GroupProps, 'size'>;

type Permissions = {
  allowNoCredit: boolean;
  allowCommercialUse: CommercialUse;
  allowDerivatives: boolean;
  allowDifferentLicense: boolean;
};
