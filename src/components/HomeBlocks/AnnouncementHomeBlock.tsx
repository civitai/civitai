import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { HomeBlockGetAll } from '~/types/router';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { createStyles, Grid } from '@mantine/core';
import { AnnouncementHomeBlockAnnouncementItem } from '~/components/HomeBlocks/components/AnnouncementHomeBlockAnnouncementItem';

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
}));

export const AnnouncementHomeBlock = ({ homeBlock }: Props) => {
  const { classes } = useStyles();

  if (!homeBlock.announcements) {
    return null;
  }

  const metadata = homeBlock.metadata as HomeBlockMetaSchema;
  const announcementsMetadata = metadata.announcements;

  console.log(homeBlock.announcements);

  return (
    <HomeBlockWrapper className={classes.root}>
      <Grid>
        {homeBlock.announcements.map((announcement) => {
          const announcementMetadata = announcementsMetadata
            ? announcementsMetadata.find((item) => item.id === announcement.id)
            : null;

          return (
            <Grid.Col key={announcement.id} xs={12} md={announcementMetadata?.colSpan ?? 6}>
              <AnnouncementHomeBlockAnnouncementItem announcement={announcement} />
            </Grid.Col>
          );
        })}
      </Grid>
    </HomeBlockWrapper>
  );
};
