import { useSearchStore } from '~/components/Search/useSearchState';
import { useInstantSearch, useSearchBox } from 'react-instantsearch-hooks-web';
import {
  Group,
  SegmentedControl,
  SegmentedControlItem,
  Text,
  ThemeIcon,
  Title,
  useMantineTheme,
} from '@mantine/core';
import { IconCategory, IconFileText } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { removeEmpty } from '~/utils/object-helpers';

export const SearchHeader = () => {
  const { uiState } = useInstantSearch();
  const { setSearchParamsByUiState, ...states } = useSearchStore((state) => state);
  const theme = useMantineTheme();
  const [index] = Object.keys(uiState);
  const { query } = useSearchBox();
  const router = useRouter();

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
    <>
      <Title>{query || `Searching for ${index}`}</Title>
      <SegmentedControl size="md" value={index} data={data} onChange={onChangeIndex} />
    </>
  );
};
