import { IndexToLabel, useSearchStore } from '~/components/Search/useSearchState';
import { useInstantSearch, usePagination, useSearchBox } from 'react-instantsearch';
import type { SegmentedControlItem } from '@mantine/core';
import {
  Box,
  Group,
  SegmentedControl,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
  UnstyledButton,
  useMantineTheme,
} from '@mantine/core';
import {
  IconCategory,
  IconFileText,
  IconPhoto,
  IconFilter,
  IconUsers,
  IconLayoutCollage,
  IconMoneybag,
  IconTools,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { removeEmpty } from '~/utils/object-helpers';
import { useSearchLayout } from '~/components/Search/SearchLayout';
import searchLayoutClasses from '~/components/Search/SearchLayout.module.scss';
import classes from './SearchHeader.module.scss';

import { numberWithCommas } from '~/utils/number-helpers';
import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
} from '~/server/common/constants';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isDefined } from '~/utils/type-guards';
import { searchIndexMap } from '~/components/Search/search.types';

export const SearchHeader = () => {
  const { uiState, status } = useInstantSearch();
  const { setSearchParamsByUiState, ...states } = useSearchStore((state) => state);
  const [index] = Object.keys(uiState);
  const { query } = useSearchBox();
  const { nbHits } = usePagination();
  const features = useFeatureFlags();
  const theme = useMantineTheme();

  const router = useRouter();
  const { sidebarOpen, setSidebarOpen } = useSearchLayout();

  const onChangeIndex = (value: string) => {
    setSearchParamsByUiState(uiState);
    const keyPath = Object.keys(searchIndexMap).find(
      (key) => searchIndexMap[key as keyof typeof searchIndexMap] === value
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
        <Group align="center" gap={8} wrap="nowrap">
          <ThemeIcon
            size={30}
            color={index === MODELS_SEARCH_INDEX ? theme.colors.dark[7] : 'transparent'}
            p={6}
            radius="xl"
          >
            <IconCategory />
          </ThemeIcon>
          Models
        </Group>
      ),
      value: MODELS_SEARCH_INDEX,
    },
    features.imageSearch
      ? {
          label: (
            <Group align="center" gap={8} wrap="nowrap">
              <ThemeIcon
                size={30}
                color={index === IMAGES_SEARCH_INDEX ? theme.colors.dark[7] : 'transparent'}
                p={6}
                radius="xl"
              >
                <IconPhoto />
              </ThemeIcon>
              Images
            </Group>
          ),
          value: IMAGES_SEARCH_INDEX,
        }
      : undefined,
    {
      label: (
        <Group align="center" gap={8} wrap="nowrap">
          <ThemeIcon
            size={30}
            color={index === ARTICLES_SEARCH_INDEX ? theme.colors.dark[7] : 'transparent'}
            p={6}
            radius="xl"
          >
            <IconFileText />
          </ThemeIcon>
          Articles
        </Group>
      ),
      value: ARTICLES_SEARCH_INDEX,
    },
    {
      label: (
        <Group align="center" gap={8} wrap="nowrap">
          <ThemeIcon
            size={30}
            color={index === COLLECTIONS_SEARCH_INDEX ? theme.colors.dark[7] : 'transparent'}
            p={6}
            radius="xl"
          >
            <IconLayoutCollage />
          </ThemeIcon>
          Collections
        </Group>
      ),
      value: COLLECTIONS_SEARCH_INDEX,
    },
    features.bounties
      ? {
          label: (
            <Group align="center" gap={8} wrap="nowrap">
              <ThemeIcon
                size={30}
                color={index === BOUNTIES_SEARCH_INDEX ? theme.colors.dark[7] : 'transparent'}
                p={6}
                radius="xl"
              >
                <IconMoneybag />
              </ThemeIcon>
              Bounties
            </Group>
          ),
          value: BOUNTIES_SEARCH_INDEX,
        }
      : undefined,
    {
      label: (
        <Group align="center" gap={8} wrap="nowrap">
          <ThemeIcon
            size={30}
            color={index === USERS_SEARCH_INDEX ? theme.colors.dark[7] : 'transparent'}
            p={6}
            radius="xl"
          >
            <IconUsers />
          </ThemeIcon>
          Users
        </Group>
      ),
      value: USERS_SEARCH_INDEX,
    },
    features.toolSearch
      ? {
          label: (
            <Group align="center" gap={8} wrap="nowrap">
              <ThemeIcon
                size={30}
                color={index === TOOLS_SEARCH_INDEX ? theme.colors.dark[7] : 'transparent'}
                p={6}
                radius="xl"
              >
                <IconTools />
              </ThemeIcon>
              Tools
            </Group>
          ),
          value: TOOLS_SEARCH_INDEX,
        }
      : undefined,
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

    return (
      <>
        <span>{nbHits > 0 ? `${hitsString} results for ` : `No results for `}</span>
        <Text c="blue" span>
          &lsquo;{query}&rsquo;
        </Text>
      </>
    );
  })();

  return (
    <Stack>
      <Title order={3}>{titleString}</Title>
      <Box style={{ overflow: 'hidden' }}>
        <Group gap="xs" wrap="nowrap" className={classes.wrapper}>
          <Tooltip label="Filters & sorting" position="bottom" withArrow>
            <UnstyledButton onClick={() => setSidebarOpen(!sidebarOpen)}>
              <ThemeIcon
                size={42}
                className="bg-gray-1 text-black dark:bg-dark-6 dark:text-white"
                radius="xl"
                p={11}
                // className={searchLayoutClasses.filterButton}
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
            withItemsBorders={false}
          />
        </Group>
      </Box>
    </Stack>
  );
};
