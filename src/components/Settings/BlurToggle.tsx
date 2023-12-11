import { ActionIcon } from '@mantine/core';
import { IconEye, IconEyeOff, TablerIconsProps } from '@tabler/icons-react';
import { useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export function BlurToggle({ children, iconProps = {} }: BlurToggleProps) {
  const user = useCurrentUser();
  const [isLoading, setIsLoading] = useState(false);

  const { mutate } = trpc.user.update.useMutation({
    onMutate() {
      setIsLoading(true);
    },
    async onSuccess() {
      await user?.refresh();
    },
    onSettled() {
      setIsLoading(false);
    },
  });

  if (!user) return null;

  const icon = user.blurNsfw ? <IconEyeOff {...iconProps} /> : <IconEye {...iconProps} />;
  const toggle = (setTo?: boolean) => mutate({ id: user.id, blurNsfw: setTo ?? !user.blurNsfw });
  if (!children)
    children = () => (
      <ActionIcon onClick={() => toggle()}>
        {user.blurNsfw ? <IconEyeOff /> : <IconEye />}
      </ActionIcon>
    );
  return children({ icon, toggle, blurred: user.blurNsfw, isLoading });
}

type BlurToggleProps = {
  iconProps?: TablerIconsProps;
  children?: ({
    icon,
    toggle,
    blurred,
  }: {
    icon: React.ReactNode;
    blurred: boolean;
    isLoading: boolean;
    toggle: (setTo?: boolean) => void;
  }) => JSX.Element;
};
