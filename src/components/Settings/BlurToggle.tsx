import { ActionIcon } from '@mantine/core';
import { IconEye, IconEyeOff, TablerIconProps } from '@tabler/icons';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export function BlurToggle({ children, iconProps = {} }: BlurToggleProps) {
  const user = useCurrentUser();
  if (!user) return null;

  const { mutate } = trpc.user.update.useMutation({
    async onSuccess() {
      user.refresh();
    },
  });

  const icon = user.blurNsfw ? <IconEyeOff {...iconProps} /> : <IconEye {...iconProps} />;
  const toggle = () => mutate({ id: user.id, blurNsfw: !user.blurNsfw });
  if (!children)
    children = () => (
      <ActionIcon onClick={toggle}>{user.blurNsfw ? <IconEyeOff /> : <IconEye />}</ActionIcon>
    );
  return children({ icon, toggle, blurred: user.blurNsfw });
}

type BlurToggleProps = {
  iconProps?: TablerIconProps;
  children?: ({
    icon,
    toggle,
    blurred,
  }: {
    icon: React.ReactNode;
    blurred: boolean;
    toggle: () => void;
  }) => JSX.Element;
};
