import { SegmentedControl, SegmentedControlItem, SegmentedControlProps } from '@mantine/core';
import { useRouter } from 'next/router';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function HomeContentToggle({ size, sx, ...props }: Props) {
  const router = useRouter();
  const features = useFeatureFlags();

  if (!features.gallery && !features.posts) return null;

  const data: SegmentedControlItem[] = [{ label: 'Models', value: 'models' }];
  // if (features.posts) data.push({ label: 'Posts', value: 'posts' });
  if (features.gallery) data.push({ label: 'Images', value: 'images' });

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
        router.pathname === '/images' ? 'images' : router.pathname === '/posts' ? 'posts' : 'models'
      }
      onChange={(value) => {
        if (value === 'images') {
          router.push('/images');
          // } else if (value === 'posts') {
          //   router.push('/posts');
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
