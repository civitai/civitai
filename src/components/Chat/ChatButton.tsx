import { ActionIcon, Card, createStyles, Indicator, Portal } from '@mantine/core';
import { IconMessage2 } from '@tabler/icons-react';
import { useState } from 'react';
import { ChatWindow } from '~/components/Chat/ChatWindow';

const useStyles = createStyles((theme) => ({
  absolute: {
    position: 'absolute',
    display: 'flex',
    bottom: theme.spacing.xs,
    left: theme.spacing.md,
    zIndex: 50,
    height: 'min(600px, 70%)',
    width: 'min(700px, 80%)',
  },
}));

export function ChatButton() {
  const [opened, setOpened] = useState(false);
  const { classes } = useStyles();

  return (
    <>
      <Indicator color="red" disabled={true}>
        <ActionIcon
          variant={opened ? 'filled' : undefined}
          onClick={() => setOpened((val) => !val)}
        >
          <IconMessage2 />
        </ActionIcon>
      </Indicator>
      <Portal target={'main'}>
        <div className={classes.absolute} style={{ display: opened ? 'block' : 'none' }}>
          <Card
            p={0}
            radius={4}
            withBorder
            shadow="md"
            sx={{
              width: '100%',
              height: '100%',
              overflow: 'hidden',
            }}
          >
            <ChatWindow setOpened={setOpened} />
          </Card>
        </div>
      </Portal>
    </>
  );
}
