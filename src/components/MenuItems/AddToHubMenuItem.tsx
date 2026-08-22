import { Menu } from '@mantine/core';
import { IconLayoutGrid } from '@tabler/icons-react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function AddToHubMenuItem({ onClick }: { onClick: VoidFunction }) {
  const features = useFeatureFlags();

  return (
    <LoginRedirect reason="add-to-hub">
      <Menu.Item
        leftSection={<IconLayoutGrid size={14} stroke={1.5} />}
        onClick={(e: React.MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }}
        className={!features.canWrite ? 'pointer-events-none' : undefined}
      >
        Add to hub
      </Menu.Item>
    </LoginRedirect>
  );
}
