import { createStyles, Grid } from '@mantine/core';
import React, { type Dispatch, type SetStateAction, useState } from 'react';
import { ChatList } from '~/components/Chat/ChatList';
import { ExistingChat } from '~/components/Chat/ExistingChat';
import { NewChat } from '~/components/Chat/NewChat';

const useStyles = createStyles((theme) => ({
  chatList: {
    borderRight: theme.colorScheme === 'dark' ? '1px solid #373A40' : '1px solid #CED4DA',
    height: '100%',
    // [containerQuery.smallerThan('xs')]: {
    //   height: '200px',
    // },
  },
}));

export function ChatWindow({ setOpened }: { setOpened: Dispatch<SetStateAction<boolean>> }) {
  const [newChat, setNewChat] = useState(true);
  const [existingChat, setExistingChat] = useState<number | undefined>(undefined);

  const { classes } = useStyles();

  return (
    <Grid h="100%" m={0}>
      {/* List and Search Panel */}
      <Grid.Col span={2} xs={4} p={0} className={classes.chatList}>
        <ChatList
          existingChat={existingChat}
          setNewChat={setNewChat}
          setExistingChat={setExistingChat}
        />
      </Grid.Col>
      {/* Chat Panel */}
      <Grid.Col span={10} xs={8} p={0} h="100%">
        {newChat || !existingChat ? (
          <NewChat
            setOpened={setOpened}
            setNewChat={setNewChat}
            setExistingChat={setExistingChat}
          />
        ) : (
          <ExistingChat
            setOpened={setOpened}
            existingChat={existingChat}
            setNewChat={setNewChat}
            setExistingChat={setExistingChat}
          />
        )}
      </Grid.Col>
    </Grid>
  );
}
