import {
  IndexToLabel,
  SearchPathToIndexMap,
  useSearchStore,
} from '~/components/Search/useSearchState';
import { useInstantSearch, usePagination, useSearchBox } from 'react-instantsearch';
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
  IconUsers,
  IconLayoutCollage,
  IconMoneybag,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { removeEmpty } from '~/utils/object-helpers';
import { useSearchLayout, useSearchLayoutStyles } from '~/components/Search/SearchLayout';
import { numberWithCommas } from '~/utils/number-helpers';
import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
} from '~/server/common/constants';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isDefined } from '~/utils/type-guards';

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
  const { uiState, status } = useInstantSearch();
  const { setSearchParamsByUiState, ...states } = useSearchStore((state) => state);
  const [index] = Object.keys(uiState);
  const { query } = useSearchBox();
  const { nbHits } = usePagination();
  const features = useFeatureFlags();

  const router = useRouter();
  const { classes, theme } = useStyles();
  const { classes: searchLayoutStyles } = useSearchLayoutStyles();
  const { sidebarOpen, setSidebarOpen } = useSearchLayout();

  const onChangeIndex = (value: string) => {
    setSearchParamsByUiState(uiState);
    const keyPath = Object.keys(SearchPathToIndexMap).find(
      (key) => SearchPathToIndexMap[key as keyof typeof SearchPathToIndexMap] === value
    );

    if (keyPath && states.hasOwnProperty(keyPath)) {
      // Redirect to the route with the relevant state:
      router.replace(
        {
          pathname: `/search/${keyPath}`,
          query: removeEmpty({
            ...states[keyPath as keyof typeof states],
            query: query || null, // Remove empty string from URL
            page: null, // restart the active page. TODO: We need to consider whether or not it makes sense to store the page in the URL.
          }),
        },
        undefined,
        { shallow: true }
      );
    } else {
      router.replace(`/search/${keyPath}${query ? `?query=${query}` : ''}`, undefined, {
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
            color={index === MODELS_SEARCH_INDEX ? theme.colors.dark[7] : 'transparent'}
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
      value: MODELS_SEARCH_INDEX,
    },
    features.imageSearch
      ? {
          label: (
            <Group align="center" spacing={8} noWrap>
              <ThemeIcon
                size={30}
                color={index === IMAGES_SEARCH_INDEX ? theme.colors.dark[7] : 'transparent'}
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
          value: IMAGES_SEARCH_INDEX,
        }
      : undefined,
    {
      label: (
        <Group align="center" spacing={8} noWrap>
          <ThemeIcon
            size={30}
            color={index === ARTICLES_SEARCH_INDEX ? theme.colors.dark[7] : 'transparent'}
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
      value: ARTICLES_SEARCH_INDEX,
    },
    {
      label: (
        <Group align="center" spacing={8} noWrap>
          <ThemeIcon
            size={30}
            color={index === COLLECTIONS_SEARCH_INDEX ? theme.colors.dark[7] : 'transparent'}
            p={6}
            radius="xl"
          >
            <IconLayoutCollage />
          </ThemeIcon>
          <Text size="sm" inline>
            Collections
          </Text>
        </Group>
      ),
      value: COLLECTIONS_SEARCH_INDEX,
    },
    features.bounties
      ? {
          label: (
            <Group align="center" spacing={8} noWrap>
              <ThemeIcon
                size={30}
                color={index === BOUNTIES_SEARCH_INDEX ? theme.colors.dark[7] : 'transparent'}
                p={6}
                radius="xl"
              >
                <IconMoneybag />
              </ThemeIcon>
              <Text size="sm" inline>
                Bounties
              </Text>
            </Group>
          ),
          value: BOUNTIES_SEARCH_INDEX,
        }
      : undefined,
    {
      label: (
        <Group align="center" spacing={8} noWrap>
          <ThemeIcon
            size={30}
            color={index === USERS_SEARCH_INDEX ? theme.colors.dark[7] : 'transparent'}
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
      value: USERS_SEARCH_INDEX,
    },
  ].filter(isDefined);

  const loading = status === 'loading' || status === 'stalled';

  const titleString: React.ReactElement | string = (() => {
    if (loading) {
      return 'Searching...';
    }

    if (!query) {
      return `Searching for ${IndexToLabel[index as keyof typeof IndexToLabel]}`;
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
