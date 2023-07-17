import React from 'react';
import { Button, Card, createStyles, Group, Stack, Text, Title } from '@mantine/core';
import ReactMarkdown from 'react-markdown';
import { GetAnnouncement } from '~/server/services/announcement.service';
import { AnnouncementMetaSchema } from '~/server/schema/announcement.schema';
import Link from 'next/link';
import { ButtonVariant } from '@mantine/core/lib/Button/Button.styles';
import { useIsMobile } from '~/hooks/useIsMobile';

const useStyles = createStyles((theme) => ({
  emojiCard: {
    background:
      theme.colorScheme === 'dark'
        ? theme.colors.dark[8]
        : theme.fn.darken(theme.colors.gray[0], 0.01),

    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 62,
    height: 62,
  },
}));

const AnnouncementHomeBlockAnnouncementItem = ({ announcement }: Props) => {
  const { classes } = useStyles();
  const announcementMetadata = announcement.metadata as AnnouncementMetaSchema;
  const { actions } = announcementMetadata || {};
  const isMobile = useIsMobile();

  return (
    <Card radius="md" p="lg" display="flex" sx={{ minHeight: '100%' }}>
      <Stack>
        <Group spacing="md" sx={{ flexWrap: 'nowrap' }}>
          {announcement.emoji && (
            <Card className={classes.emojiCard} radius="lg" p="sm">
              <Text size={28} p={0}>
                {announcement.emoji}
              </Text>
            </Card>
          )}
          <Title order={3}>{announcement.title}</Title>
        </Group>

        <Text>
          <ReactMarkdown allowedElements={['a']} unwrapDisallowed className="markdown-content">
            {announcement.content}
          </ReactMarkdown>
        </Text>

        <Group mt="auto">
          {actions &&
            actions.map((action, index) => {
              if (action.type === 'button') {
                return (
                  <Link key={index} href={action.link} passHref>
                    <Button
                      sx={
                        isMobile
                          ? {
                              display: 'flex',
                              flexGrow: 1,
                              justifyContent: 'center',
                            }
                          : undefined
                      }
                      variant={action.variant ? (action.variant as ButtonVariant) : undefined}
                    >
                      <Text>{action.linkText}</Text>
                    </Button>
                  </Link>
                );
              }

              return null;
            })}
        </Group>
      </Stack>
    </Card>
  );
};

type Props = { announcement: GetAnnouncement };

export { AnnouncementHomeBlockAnnouncementItem };
