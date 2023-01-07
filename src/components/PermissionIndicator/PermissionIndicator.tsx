import { Group, List, Popover, Text } from '@mantine/core';
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

export const PermissionIndicator = ({ permissions, size = 20 }: Props) => {
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
    !allowNoCredit && <IconUserCheck key="by" {...iconProps} />,
    !canSellImages && <IconPhotoOff key="no-images" {...iconProps} />,
    !canRent && <IconBrushOff key="no-rent" {...iconProps} />,
    !canSell && <IconShoppingCartOff key="no-sell" {...iconProps} />,
    !allowDerivatives && <IconExchangeOff key="no-merges" {...iconProps} />,
    !allowDifferentLicense && <IconRotate2 key="sa" {...iconProps} />,
  ].filter(Boolean);
  return (
    <Popover withArrow>
      <Popover.Target>
        <Group spacing={2} sx={{ cursor: 'pointer' }}>
          {icons}
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
};

type Permissions = {
  allowNoCredit: boolean;
  allowCommercialUse: CommercialUse;
  allowDerivatives: boolean;
  allowDifferentLicense: boolean;
};
