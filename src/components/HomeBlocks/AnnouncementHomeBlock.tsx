import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { HomeBlockGetAll } from '~/types/router';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { Card, createStyles, Grid, Group, Stack, Text, Title } from '@mantine/core';
import ReactMarkdown from 'react-markdown';

type Props = { homeBlock: HomeBlockGetAll[number] };

const useStyles = createStyles((theme) => ({
  root: {
    paddingTop: '32px',
    paddingBottom: '32px',
    background:
      theme.colorScheme === 'dark'
        ? theme.colors.dark[8]
        : theme.fn.darken(theme.colors.gray[0], 0.01),
  },
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

export const AnnouncementHomeBlock = ({ homeBlock }: Props) => {
  const { classes } = useStyles();

  if (!homeBlock.announcements) {
    return null;
  }

  const metadata = homeBlock.metadata as HomeBlockMetaSchema;
  const announcementsMeta = metadata.announcements;

  console.log(homeBlock.announcements);

  return (
    <HomeBlockWrapper className={classes.root}>
      <Grid>
        {homeBlock.announcements.map((announcement) => {
          const meta = announcementsMeta
            ? announcementsMeta.find((item) => item.id === announcement.id)
            : null;

          return (
            <Grid.Col key={announcement.id} xs={12} md={meta?.colSpan ?? 6}>
              <Card radius="md" p="lg" sx={{ minHeight: '100%' }}>
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
                    <ReactMarkdown
                      allowedElements={['a']}
                      unwrapDisallowed
                      className="markdown-content"
                    >
                      {announcement.content}
                    </ReactMarkdown>
                  </Text>
                </Stack>
              </Card>
            </Grid.Col>
          );
        })}
      </Grid>
    </HomeBlockWrapper>
  );
};
