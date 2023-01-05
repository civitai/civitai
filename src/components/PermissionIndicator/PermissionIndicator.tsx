import { Group, List, Popover, Text } from '@mantine/core';
import {
  IconCheck,
  IconCreativeCommonsBy,
  IconCreativeCommonsNc,
  IconCreativeCommonsNd,
  IconCreativeCommonsSa,
  IconX,
} from '@tabler/icons';

export const PermissionIndicator = ({ permissions, size = 20 }: Props) => {
  const { allowCommercialUse, allowDerivatives, allowDifferentLicense } = permissions;

  const explanation = {
    'Use this model for commercial purposes': allowCommercialUse,
    'Use in merges you share': allowDerivatives,
    'Use a different license when sharing': allowDifferentLicense,
  };
  const iconProps = { size, stroke: 1.5 };
  const icons = [
    !allowCommercialUse && <IconCreativeCommonsNc key="nc" {...iconProps} />,
    !allowDerivatives && <IconCreativeCommonsNd key="nd" {...iconProps} />,
    !allowDifferentLicense && <IconCreativeCommonsSa key="sa" {...iconProps} />,
  ].filter(Boolean);
  return (
    <Popover withArrow>
      <Popover.Target>
        <Group spacing={0} sx={{ cursor: 'pointer' }}>
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
                  <IconCheck style={{ color: 'green' }} size={12} />
                ) : (
                  <IconX style={{ color: 'red' }} size={12} />
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
  allowCommercialUse: boolean;
  allowDerivatives: boolean;
  allowDifferentLicense: boolean;
};
