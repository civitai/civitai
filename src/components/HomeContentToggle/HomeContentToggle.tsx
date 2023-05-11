import { SegmentedControl, SegmentedControlItem, SegmentedControlProps } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { useRouter } from 'next/router';

const homeOptions = {
  models: '/',
  images: '/images',
  posts: '/posts',
  articles: '/articles',
} as const;
type HomeOptions = keyof typeof homeOptions;

export function useHomeSelection() {
  const [home, setHome] = useLocalStorage<HomeOptions>({
    key: 'home-selection',
    defaultValue: 'models',
  });

  const url = homeOptions[home];
  const set = (value: HomeOptions) => {
    setHome(value);
    return homeOptions[value];
  };

  return { home, url, set };
}

export function HomeContentToggle({ size, sx, ...props }: Props) {
  const router = useRouter();
  const { set } = useHomeSelection();

  const data: SegmentedControlItem[] = [
    { label: 'Models', value: 'models' },
    { label: 'Images', value: 'images' },
    { label: 'Posts', value: 'posts' },
    { label: 'Articles', value: 'articles' },
  ];

  return (
    <SegmentedControl
      {...props}
      sx={(theme) => ({
        ...(typeof sx === 'function' ? sx(theme) : sx),
      })}
      styles={(theme) => ({
        label: {
          [theme.fn.largerThan('xs')]: {
            paddingTop: 0,
            paddingBottom: 0,
          },
        },
      })}
      value={router.pathname.split('/').pop() || 'models'}
      onChange={(value) => {
        const url = set(value as HomeOptions);
        router.push(url);
      }}
      data={data}
    />
  );
}

type Props = {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
} & Omit<SegmentedControlProps, 'data' | 'value' | 'onChange'>;
