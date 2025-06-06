import { Menu } from '@mantine/core';
import { IconBookmark } from '@tabler/icons-react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function AddToCollectionMenuItem({ onClick }: Props) {
  const features = useFeatureFlags();

  return (
    <LoginRedirect reason="add-to-collection">
      <Menu.Item
        leftSection={<IconBookmark size={14} stroke={1.5} />}
        onClick={(e: React.MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }}
        className={!features.canWrite ? 'pointer-events-none' : undefined}
      >
        Save
      </Menu.Item>
    </LoginRedirect>
  );
}

type Props = { onClick: VoidFunction };
