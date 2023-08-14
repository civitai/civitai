import { useSearchStore } from '~/components/Search/useSearchState';
import { useInstantSearch, useSearchBox } from 'react-instantsearch';
import {
  ActionIcon,
  createStyles,
  Group,
  SegmentedControl,
  SegmentedControlItem,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { IconCategory, IconFileText, IconPhoto, IconFilter } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { removeEmpty } from '~/utils/object-helpers';
import { useSearchLayoutCtx } from '~/components/Search/SearchLayout';

const useStyles = createStyles((theme) => ({
  label: {
    paddingTop: 6,
    paddingBottom: 6,
    paddingLeft: 6,
    paddingRight: 10,
  },
  root: {
    backgroundColor: 'transparent',
    gap: 8,

    [theme.fn.smallerThan('sm')]: {
      overflow: 'auto hidden',
      maxWidth: '100%',
    },
  },
  control: {
    border: 'none !important',
    backgroundColor: theme.colors.dark[6],
    borderRadius: theme.radius.xl,
  },
  active: { borderRadius: theme.radius.xl },
  controlActive: {
    borderRadius: theme.radius.xl,
    backgroundColor: theme.colors.gray[3],
    '& label': {
      color: theme.colors.dark[7],

      '&:hover': {
        color: theme.colors.dark[3],
      },
    },
  },
}));
export const SearchHeader = () => {
  const { uiState } = useInstantSearch();
  const { setSearchParamsByUiState, ...states } = useSearchStore((state) => state);
  const [index] = Object.keys(uiState);
  const { query } = useSearchBox();
  const router = useRouter();
  const { classes, theme } = useStyles();
  const { sidebarOpen, setSidebarOpen } = useSearchLayoutCtx();

  const onChangeIndex = (value: string) => {
    setSearchParamsByUiState(uiState);

    if (states.hasOwnProperty(value)) {
      // Redirect to the route with the relevant state:
      router.replace(
        {
          pathname: `/search/${value}`,
          query: removeEmpty({
            ...states[value as keyof typeof states],
            query: query || null, // Remove empty string from URL
          }),
        },
        undefined,
        { shallow: true }
      );
    } else {
      router.replace(`/search/${value}`);
    }
  };

  const data: SegmentedControlItem[] = [
    {
      label: (
        <Group align="center" spacing={8} noWrap>
          <ThemeIcon
            size={30}
            color={index === 'models' ? theme.colors.dark[7] : 'transparent'}
            p={6}
            radius="xl"
          >
            <IconCategory />
          </ThemeIcon>
          <Text size="sm" inline>
            Models
          </Text>
        </Group>
      ),
      value: 'models',
    },
    {
      label: (
        <Group align="center" spacing={8} noWrap>
          <ThemeIcon
            size={30}
            color={index === 'images' ? theme.colors.dark[7] : 'transparent'}
            p={6}
            radius="xl"
          >
            <IconPhoto />
          </ThemeIcon>
          <Text size="sm" inline>
            Images
          </Text>
        </Group>
      ),
      value: 'images',
    },
    {
      label: (
        <Group align="center" spacing={8} noWrap>
          <ThemeIcon
            size={30}
            color={index === 'articles' ? theme.colors.dark[7] : 'transparent'}
            p={6}
            radius="xl"
          >
            <IconFileText />
          </ThemeIcon>
          <Text size="sm" inline>
            Articles
          </Text>
        </Group>
      ),
      value: 'articles',
    },
  ];

  return (
    <Stack>
      <Title>{query ? `"${query}"` : `Searching for ${index}`}</Title>
      <Group>
        <Tooltip label="Filters & Sort" position="bottom" withArrow>
          <UnstyledButton onClick={() => setSidebarOpen(!sidebarOpen)}>
            <ThemeIcon
              size={30}
              color={index === 'articles' ? theme.colors.dark[7] : 'transparent'}
              p={6}
              radius="xl"
            >
              <IconFilter />
            </ThemeIcon>
          </UnstyledButton>
        </Tooltip>
        <SegmentedControl
          classNames={classes}
          size="md"
          value={index}
          data={data}
          onChange={onChangeIndex}
        />
      </Group>
    </Stack>
  );
};
