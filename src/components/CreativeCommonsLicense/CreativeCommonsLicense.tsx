import { Anchor, Button, List, Popover, Text } from '@mantine/core';
import { IconExternalLink, IconMinus, IconPlus } from '@tabler/icons';
import Link from 'next/link';

export const CreativeCommonsLicense = ({ permissions, size = 'sm' }: Props) => {
  const { allowNoCredit, allowCommercialUse, allowDerivatives, allowDifferentLicense } =
    permissions;
  const license = allowNoCredit
    ? 'zero/1.0'
    : `by${allowCommercialUse ? '' : '-nc'}${allowDerivatives ? '' : '-nd'}${
        !allowDifferentLicense && allowDerivatives ? '-sa' : ''
      }/4.0`;

  const explanation = {
    'Use without crediting this model': allowNoCredit,
    'Use this model for commercial purposes': allowCommercialUse,
    'Use in merges you share': allowDerivatives,
    'Use a different license when sharing': allowDifferentLicense,
  };
  return (
    <Popover withArrow>
      <Popover.Target>
        <img
          style={{ cursor: 'pointer' }}
          src={`https://licensebuttons.net/l/${license}/${size == 'xs' ? '80x15' : '88x31'}.png`}
          alt="Creative Commons License"
        />
      </Popover.Target>
      <Popover.Dropdown>
        <Text weight={500}>This model permits users to:</Text>
        <List
          size="xs"
          mb="sm"
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
                  <IconPlus style={{ color: 'green' }} size={12} />
                ) : (
                  <IconMinus style={{ color: 'red' }} size={12} />
                )
              }
            >
              {permission}
            </List.Item>
          ))}
        </List>
        <Button
          component="a"
          href={`https://creativecommons.org/licenses/${license}/`}
          target="_blank"
          size="xs"
          compact
          fullWidth
          rightIcon={<IconExternalLink size={16} />}
        >
          Learn More
        </Button>
      </Popover.Dropdown>
    </Popover>
  );
};

type Props = {
  permissions: Permissions;
  size?: 'xs' | 'sm';
};

type Permissions = {
  allowNoCredit: boolean;
  allowCommercialUse: boolean;
  allowDerivatives: boolean;
  allowDifferentLicense: boolean;
};
