import type { GroupProps } from '@mantine/core';
import { Box, Group, List, Popover, Text, Tooltip, useMantineTheme } from '@mantine/core';
import {
  IconBrush,
  IconCheck,
  IconCurrencyDollar,
  IconGitMerge,
  IconLicense,
  IconRating18Plus,
  IconUser,
  IconX,
} from '@tabler/icons-react';
import React from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { CommercialUse } from '~/shared/utils/prisma/enums';

export const PermissionIndicator = ({
  permissions,
  size = 24,
  gap = 4,
  showNone = false,
  ...props
}: Props) => {
  const currentUser = useCurrentUser();
  const isModerator = currentUser?.isModerator ?? false;
  const theme = useMantineTheme();

  const { allowNoCredit, allowCommercialUse, allowDerivatives, allowDifferentLicense, sfwOnly } =
    permissions;
  const canSellImages = allowCommercialUse.includes(CommercialUse.Image);
  const canRentCivit = allowCommercialUse.includes(CommercialUse.RentCivit);
  const canRent = allowCommercialUse.includes(CommercialUse.Rent);
  const canSell = allowCommercialUse.includes(CommercialUse.Sell);

  const explanation = {
    'Use the model without crediting the creator': allowNoCredit,
    'Sell images they generate': canSellImages,
    'Run on services that generate for money': canRent,
    'Run on Civitai': canRentCivit,
    'Share merges using this model': allowDerivatives,
    'Sell this model or merges using this model': canSell,
    'Have different permissions when sharing merges': allowDifferentLicense,
    ...(isModerator && { 'Create NSFW generations': !sfwOnly }),
  };

  const iconSize = Math.round(size / 2);
  const badges: { label: string; icon: React.ReactNode; allowed: boolean; visible?: boolean }[] = [
    {
      label: canSellImages || canSell ? 'Commercial use allowed' : 'No commercial use',
      icon: <IconCurrencyDollar size={iconSize} stroke={1.5} />,
      allowed: canSellImages || canSell,
    },
    {
      label: canRentCivit || canRent ? 'Generation services allowed' : 'No generation services',
      icon: <IconBrush size={iconSize} stroke={1.5} />,
      allowed: canRentCivit || canRent,
    },
    {
      label: allowNoCredit ? 'No credit required' : 'Creator credit required',
      icon: <IconUser size={iconSize} stroke={1.5} />,
      allowed: allowNoCredit,
    },
    {
      label: allowDerivatives ? 'Merges allowed' : 'No merges allowed',
      icon: <IconGitMerge size={iconSize} stroke={1.5} />,
      allowed: allowDerivatives,
    },
    {
      label: allowDifferentLicense
        ? 'Different permissions allowed on merges'
        : 'Same permissions required on merges',
      icon: <IconLicense size={iconSize} stroke={1.5} />,
      allowed: allowDifferentLicense,
    },
    {
      label: sfwOnly ? 'No NSFW generation' : 'NSFW generation allowed',
      icon: <IconRating18Plus size={iconSize} stroke={1.5} />,
      allowed: !sfwOnly,
      visible: isModerator,
    },
  ];

  return (
    <Popover withArrow withinPortal>
      <Popover.Target>
        <Group gap={gap} style={{ cursor: 'pointer' }} wrap="nowrap" {...props}>
          {badges
            .filter((b) => b.visible !== false)
            .map(({ label, icon, allowed }, i) => (
              <Tooltip key={i} label={label} withArrow withinPortal position="top">
                <Box
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: size,
                    height: size,
                    borderRadius: theme.radius.sm,
                    backgroundColor: allowed ? 'rgba(64, 192, 87, 0.2)' : 'rgba(250, 82, 82, 0.2)',
                    color: allowed ? theme.colors.green[4] : theme.colors.red[4],
                  }}
                >
                  {icon}
                </Box>
              </Tooltip>
            ))}
          {showNone && badges.filter((b) => b.visible !== false).every((b) => b.allowed) && (
            <Text fs="italic" size="xs">
              None
            </Text>
          )}
        </Group>
      </Popover.Target>
      <Popover.Dropdown>
        <Text fw={500}>This model permits users to:</Text>
        <List
          size="xs"
          styles={{
            itemIcon: { marginRight: 4, paddingTop: 2 },
          }}
        >
          {Object.entries(explanation).map(([permission, allowed], i) => (
            <List.Item
              key={i}
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
  showNone?: boolean;
} & Omit<GroupProps, 'size'>;

type Permissions = {
  allowNoCredit: boolean;
  allowCommercialUse: CommercialUse[];
  allowDerivatives: boolean;
  allowDifferentLicense: boolean;
  sfwOnly: boolean;
};
