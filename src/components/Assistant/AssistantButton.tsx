import { Button, ButtonProps } from '@mantine/core';
import { IconCat, IconMessageChatbot, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { AssistantChat } from '~/components/Assistant/AssistantChat';
import { env } from '~/env/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { isApril1 } from '~/utils/date-helpers';

const WIDTH = 320;
const HEIGHT = 500;

export function AssistantButton({ ...props }: ButtonProps) {
  const [open, setOpen] = useState(false);
  const currentUser = useCurrentUser();

  if (!currentUser) return null;

  const gpttUUID = isApril1()
    ? env.NEXT_PUBLIC_GPTT_UUID_ALT ?? env.NEXT_PUBLIC_GPTT_UUID
    : env.NEXT_PUBLIC_GPTT_UUID;
  if (!gpttUUID) return null;

  const Icon = isApril1() ? IconCat : IconMessageChatbot;
  const color = isApril1() ? 'pink' : 'blue';

  return (
    <>
      {open && (
        <div className="absolute bottom-full right-0 mb-1">
          <AssistantChat width={WIDTH} height={HEIGHT} />
        </div>
      )}
      <Button
        component="span"
        px="xs"
        {...props}
        color={open ? 'gray' : color}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <IconX size={20} stroke={2.5} /> : <Icon size={20} stroke={2.5} />}
      </Button>
    </>
  );
}
