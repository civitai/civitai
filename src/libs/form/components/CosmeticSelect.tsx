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
import { BadgeCosmetic } from '~/server/selectors/cosmetic.selector';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import Link from 'next/link';

const useStyles = createStyles((theme) => ({
  decoration: {
    borderRadius: theme.radius.md,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[1],
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },

  selected: {
    border: `2px solid ${theme.colors.blue[4]}`,
  },

  noContent: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[8] : theme.colors.gray[1],
    gridColumn: '2 / min-content',
  },
}));

export function CosmeticSelect({
  data,
  value = null,
  onChange,
  gridProps,
  nothingFound,
  shopUrl,
  ...props
}: Props) {
  const { classes, cx } = useStyles();

  const handleClick = (id: number | null) => {
    onChange?.(id);
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
            const data = item.data ?? {};
            const url = data.url ?? '';
            const isSelected = value === item.id;

            return (
              <Indicator
                key={item.id}
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
                  onClick={() => handleClick(!isSelected ? item.id : null)}
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

type Props = Omit<InputWrapperProps, 'onChange' | 'children'> & {
  data: Pick<BadgeCosmetic, 'id' | 'data' | 'name' | 'inUse'>[];
  shopUrl?: string;
  onChange?: (id: number | null) => void;
  value?: number | null;
  nothingFound?: React.ReactNode;
  gridProps?: SimpleGridProps;
};
