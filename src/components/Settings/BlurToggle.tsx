import { ActionIcon } from '@mantine/core';
import { IconEye, IconEyeOff, TablerIconProps } from '@tabler/icons';
import { useSession } from 'next-auth/react';
import { reloadSession } from '~/utils/next-auth-helpers';
import { trpc } from '~/utils/trpc';

export function BlurToggle({ children, iconProps = {} }: BlurToggleProps) {
  const { data: session } = useSession();
  const user = session?.user;
  // const utils = trpc.useContext();
  if (!user) return null;

  const { mutate } = trpc.user.update.useMutation({
    async onSuccess() {
      // await utils.model.getAll.invalidate();
      // await utils.review.getAll.invalidate();
      await reloadSession();
    },
  });

  const icon = user?.blurNsfw ? <IconEyeOff {...iconProps} /> : <IconEye {...iconProps} />;
  const toggle = () => mutate({ id: user?.id, blurNsfw: !user?.blurNsfw });
  if (!children)
    children = () => (
      <ActionIcon onClick={toggle}>{user?.blurNsfw ? <IconEyeOff /> : <IconEye />}</ActionIcon>
    );
  return children({ icon, toggle });
}

type BlurToggleProps = {
  iconProps?: TablerIconProps;
  children?: ({ icon, toggle }: { icon: React.ReactNode; toggle: () => void }) => JSX.Element;
};
