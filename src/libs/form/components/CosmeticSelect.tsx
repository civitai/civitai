import {
  Center,
  Indicator,
  Input,
  InputWrapperProps,
  Paper,
  SimpleGrid,
  SimpleGridProps,
  Stack,
  Text,
  UnstyledButton,
  createStyles,
} from '@mantine/core';
import { IconBuildingStore } from '@tabler/icons-react';
import { BadgeCosmetic, SimpleCosmetic, WithClaimKey } from '~/server/selectors/cosmetic.selector';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import Link from 'next/link';

const useStyles = createStyles((theme) => ({
  decoration: {
    borderRadius: theme.radius.md,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[1],
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    width: '100%',
  },

  selected: {
    border: `2px solid ${theme.colors.blue[4]}`,
  },

  noContent: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[1],
    gridColumn: '2 / min-content',
  },
}));

export function CosmeticSelect<TData extends CosmeticItem>({
  data,
  value = null,
  onChange,
  gridProps,
  nothingFound,
  shopUrl,
  ...props
}: Props<TData>) {
  const { classes, cx } = useStyles();

  const handleClick = (value: TData | null) => {
    onChange?.(value);
  };

  const hasItems = data.length > 0;

  return (
    <Input.Wrapper {...props}>
      <SimpleGrid
        spacing={16}
        breakpoints={[
          { cols: 3, maxWidth: 'xs' },
          { cols: 4, minWidth: 'xs' },
          { cols: 5, minWidth: 'sm' },
          { cols: 7, minWidth: 'md' },
        ]}
        {...gridProps}
      >
        {shopUrl && (
          <Link href={shopUrl}>
            <UnstyledButton p="sm" className={classes.decoration}>
              <Stack spacing={4} align="center" justify="center">
                <IconBuildingStore size={24} />
                <Text size="sm" weight={500}>
                  Shop
                </Text>
              </Stack>
            </UnstyledButton>
          </Link>
        )}
        {hasItems ? (
          data.map((item) => {
            const data = item.data as BadgeCosmetic['data'];
            const url = data.url ?? '';
            const isSelected = value && value.id === item.id && value.claimKey === item.claimKey;

            return (
              <Indicator
                key={`${item.id}:${item.claimKey}`}
                label="In use"
                position="top-center"
                disabled={!item.inUse}
                color="gray.1"
                styles={{
                  indicator: { color: '#222', height: 'auto !important', fontWeight: 500 },
                }}
                inline
              >
                <UnstyledButton
                  className={cx(classes.decoration, isSelected && classes.selected)}
                  p="sm"
                  onClick={() => handleClick(!isSelected ? item : null)}
                >
                  <EdgeMedia src={url} width={data.animated ? 'original' : 64} />
                </UnstyledButton>
              </Indicator>
            );
          })
        ) : (
          <Paper className={classes.noContent} p="sm" radius="md">
            <Center>
              {nothingFound ? (
                nothingFound
              ) : (
                <Text size="sm" weight={500}>
                  No decorations
                </Text>
              )}
            </Center>
          </Paper>
        )}
      </SimpleGrid>
    </Input.Wrapper>
  );
}

type CosmeticItem = WithClaimKey<
  Pick<SimpleCosmetic, 'id' | 'data' | 'equippedToId' | 'equippedToType' | 'inUse' | 'obtainedAt'>
>;
type Props<TData extends CosmeticItem> = Omit<InputWrapperProps, 'onChange' | 'children'> & {
  data: TData[];
  shopUrl?: string;
  onChange?: (value: TData | null) => void;
  value?: TData | null;
  nothingFound?: React.ReactNode;
  gridProps?: SimpleGridProps;
};
