import { useSearchStore } from '~/components/Search/useSearchState';
import {
  useInfiniteHits,
  useInstantSearch,
  usePagination,
  useSearchBox,
} from 'react-instantsearch';
import {
  Box,
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
import {
  IconCategory,
  IconFileText,
  IconPhoto,
  IconFilter,
  IconUser,
  IconUsers,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { removeEmpty } from '~/utils/object-helpers';
import { useSearchLayout, useSearchLayoutStyles } from '~/components/Search/SearchLayout';
import { numberWithCommas } from '~/utils/number-helpers';

const useStyles = createStyles((theme) => ({
  wrapper: {
    [theme.fn.smallerThan('sm')]: {
      overflow: 'auto',
      maxWidth: '100%',
    },
  },
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
      overflow: 'visible',
      maxWidth: '100%',
    },
  },
  control: {
    border: 'none !important',
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[1],
    svg: {
      color: theme.colorScheme === 'dark' ? theme.colors.gray[1] : theme.colors.dark[6],
    },
    borderRadius: theme.radius.xl,
  },
  active: { borderRadius: theme.radius.xl },
  controlActive: {
    borderRadius: theme.radius.xl,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.gray[3] : theme.colors.dark[6],
    svg: {
      color: theme.colorScheme === 'dark' ? undefined : theme.colors.gray[1],
    },
    '& label': {
      color: theme.colorScheme === 'dark' ? theme.colors.dark[7] : theme.colors.gray[1],

      '&:hover': {
        color: theme.colorScheme === 'dark' ? theme.colors.dark[3] : theme.colors.gray[2],
      },
    },
  },
}));
export const SearchHeader = () => {
  const { uiState } = useInstantSearch();
  const { setSearchParamsByUiState, ...states } = useSearchStore((state) => state);
  const [index] = Object.keys(uiState);
  const { query } = useSearchBox();
  const { nbHits } = usePagination();

  const router = useRouter();
  const { classes, theme } = useStyles();
  const { classes: searchLayoutStyles } = useSearchLayoutStyles();
  const { sidebarOpen, setSidebarOpen } = useSearchLayout();

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
            page: null, // restart the active page. TODO: We need to consider whether or not it makes sense to store the page in the URL.
          }),
        },
        undefined,
        { shallow: true }
      );
    } else {
      router.replace(`/search/${value}${query ? `?query=${query}` : ''}`, undefined, {
        shallow: true,
      });
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
    {
      label: (
        <Group align="center" spacing={8} noWrap>
          <ThemeIcon
            size={30}
            color={index === 'users' ? theme.colors.dark[7] : 'transparent'}
            p={6}
            radius="xl"
          >
            <IconUsers />
          </ThemeIcon>
          <Text size="sm" inline>
            Users
          </Text>
        </Group>
      ),
      value: 'users',
    },
  ];

  const titleString: React.ReactElement | string = (() => {
    if (!query) {
      return `Searching for ${index}`;
    }

    const hitsString =
      nbHits === 1000 ? `Over ${numberWithCommas(nbHits)}` : numberWithCommas(nbHits);

    const queryItem = (
      <Text color="blue" span>
        &lsquo;{query}&rsquo;
      </Text>
    );

    return (
      <Text>
        {nbHits > 0 ? (
          <>
            {hitsString} results for {queryItem}
          </>
        ) : (
          <>No results for {queryItem}</>
        )}
      </Text>
    );
  })();

  return (
    <Stack>
      <Title order={3}>{titleString}</Title>
      <Box sx={{ overflow: 'hidden' }}>
        <Group spacing="xs" noWrap className={classes.wrapper}>
          <Tooltip label="Filters & sorting" position="bottom" withArrow>
            <UnstyledButton onClick={() => setSidebarOpen(!sidebarOpen)}>
              <ThemeIcon
                size={42}
                color="gray"
                radius="xl"
                p={11}
                className={searchLayoutStyles.filterButton}
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
      </Box>
    </Stack>
  );
};
