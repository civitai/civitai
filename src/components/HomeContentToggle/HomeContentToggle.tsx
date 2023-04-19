import { SegmentedControl, SegmentedControlItem, SegmentedControlProps } from '@mantine/core';
import { useRouter } from 'next/router';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function HomeContentToggle({ size, sx, ...props }: Props) {
  const router = useRouter();
  const features = useFeatureFlags();

  const data: SegmentedControlItem[] = [
    { label: 'Models', value: 'models' },
    { label: 'Images', value: 'images' },
  ];
  if (features.posts) data.push({ label: 'Posts', value: 'posts' });

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
      value={
        router.pathname === '/images'
          ? 'images'
          : ['/posts', '/posts/feed'].includes(router.pathname)
          ? 'posts'
          : 'models'
      }
      onChange={(value) => {
        if (value === 'images') {
          router.push('/images');
        } else if (value === 'posts') {
          router.push('/posts');
        } else {
          router.push('/');
        }
      }}
      data={data}
    />
  );
}

type Props = {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
} & Omit<SegmentedControlProps, 'data' | 'value' | 'onChange'>;
