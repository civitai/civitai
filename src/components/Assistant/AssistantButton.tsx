import { Button, ButtonProps } from '@mantine/core';
import { IconMessageChatbot, IconX } from '@tabler/icons-react';
import { AssistantChat } from '~/components/Assistant/AssistantChat';
import { env } from '~/env/client';
import { isProd } from '~/env/other';
import { useState } from 'react';

const WIDTH = 320;
const HEIGHT = 500;
export function AssistantButton({ ...props }: ButtonProps) {
  const [open, setOpen] = useState(false);
  if (!env.NEXT_PUBLIC_GPTT_UUID && isProd) return null;

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
        color={open ? 'gray' : 'blue'}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <IconX size={20} stroke={2.5} /> : <IconMessageChatbot size={20} stroke={2.5} />}
      </Button>
    </>
  );
}
