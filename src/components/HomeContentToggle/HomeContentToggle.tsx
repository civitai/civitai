import { SegmentedControl, SegmentedControlProps } from '@mantine/core';
import { useRouter } from 'next/router';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function HomeContentToggle({ size, sx, ...props }: Props) {
  const router = useRouter();
  const features = useFeatureFlags();

  if (!features.gallery) return null;

  return (
    <SegmentedControl
      {...props}
      sx={(theme) => ({
        ...(typeof sx === 'function' ? sx(theme) : sx),
      })}
      styles={(theme) => ({
        root: {
          // padding: 0,
        },
        label: {
          [theme.fn.largerThan('xs')]: {
            paddingTop: 0,
            paddingBottom: 0,
          },
        },
      })}
      value={
        router.pathname === '/images' ? 'images' : router.pathname === '/posts' ? 'posts' : 'models'
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
      data={[
        { label: 'Models', value: 'models' },
        { label: 'Posts', value: 'posts' },
        { label: 'Images', value: 'images' },
      ]}
    />
  );
}

type Props = {
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
} & Omit<SegmentedControlProps, 'data' | 'value' | 'onChange'>;
