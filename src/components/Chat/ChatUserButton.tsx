import type { ButtonProps } from '@mantine/core';
import { Button, Group, useComputedColorScheme, useMantineTheme } from '@mantine/core';
import { IconMessage2 } from '@tabler/icons-react';
import { useChatStore } from '~/components/Chat/ChatProvider';
import { useChatEnabled } from '~/components/Chat/useChatEnabled';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { UserWithCosmetics } from '~/server/selectors/user.selector';

export function ChatUserButton({
  user,
  label,
  ...buttonProps
}: {
  user: Partial<UserWithCosmetics>;
  label?: string;
} & ButtonProps) {
  const theme = useMantineTheme();
  const chatEnabled = useChatEnabled();
  const currentUser = useCurrentUser();
  const colorScheme = useComputedColorScheme('dark');

  const handleClick = () => {
    useChatStore.setState((state) => ({
      open: !state.open,
      isCreating: true,
      existingChatId: undefined,
      selectedUsers: [user],
    }));
  };

  if (!chatEnabled || user.id === currentUser?.id) return <></>;

  return (
    <LoginPopover>
      <Button
        variant={colorScheme === 'dark' ? 'filled' : 'light'}
        color="gray"
        radius="xl"
        pl={8}
        pr={label ? 12 : 8}
        onClick={handleClick}
        // TODO do we like this color
        style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.5, color: theme.colors.success[2] }}
        {...buttonProps}
      >
        <Group gap={4} wrap="nowrap">
          <IconMessage2 size={14} />
          {label ?? 'Chat'}
        </Group>
      </Button>
    </LoginPopover>
  );
}
