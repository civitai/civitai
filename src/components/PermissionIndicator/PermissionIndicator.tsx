import { Box, Group, GroupProps, List, Popover, Text, Tooltip } from '@mantine/core';
import {
  IconBrushOff,
  IconCheck,
  IconExchangeOff,
  IconHorseToy,
  IconPhotoOff,
  IconRotate2,
  IconShoppingCartOff,
  IconUserCheck,
  IconWorldOff,
  IconX,
} from '@tabler/icons-react';
import React from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { CommercialUse } from '~/shared/utils/prisma/enums';

export const PermissionIndicator = ({ permissions, size = 20, spacing = 2, ...props }: Props) => {
  const currentUser = useCurrentUser();
  const isModerator = currentUser?.isModerator ?? false;

  const { allowNoCredit, allowCommercialUse, allowDerivatives, allowDifferentLicense, minor } =
    permissions;
  const canSellImages = allowCommercialUse.includes(CommercialUse.Image);
  const canRentCivit = allowCommercialUse.includes(CommercialUse.RentCivit);
  const canRent = allowCommercialUse.includes(CommercialUse.Rent);
  const canSell = allowCommercialUse.includes(CommercialUse.Sell);

  const explanation = {
    'Use the model without crediting the creator': allowNoCredit,
    'Sell images they generate': canSellImages,
    'Run on services that generate images for money': canRent,
    'Run on Civitai': canRentCivit,
    'Share merges using this model': allowDerivatives,
    'Sell this model or merges using this model': canSell,
    'Have different permissions when sharing merges': allowDifferentLicense,
    ...(isModerator && { 'Create NSFW generations': !minor }),
  };
  const iconProps = { size, stroke: 1.5 };
  const icons = [
    isModerator && minor && { label: 'Minor (no NSFW gen)', icon: <IconHorseToy {...iconProps} /> },
    !allowNoCredit && { label: 'Creator credit required', icon: <IconUserCheck {...iconProps} /> },
    !canSellImages && { label: 'No selling images', icon: <IconPhotoOff {...iconProps} /> },
    !canRentCivit && { label: 'No Civitai generation', icon: <IconBrushOff {...iconProps} /> },
    !canRent && { label: 'No generation services', icon: <IconWorldOff {...iconProps} /> },
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
  allowCommercialUse: CommercialUse[];
  allowDerivatives: boolean;
  allowDifferentLicense: boolean;
  minor: boolean;
};
