import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { HomeBlockGetAll } from '~/types/router';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';
import { createStyles, Grid } from '@mantine/core';
import { AnnouncementHomeBlockAnnouncementItem } from '~/components/HomeBlocks/components/AnnouncementHomeBlockAnnouncementItem';
import { useDismissedAnnouncements } from '~/hooks/useDismissedAnnouncements';
import { useMemo } from 'react';
import { HomeBlockHeaderMeta } from '~/components/HomeBlocks/components/HomeBlockHeaderMeta';

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
  const announcementIds = useMemo(
    () => (homeBlock.announcements ? homeBlock.announcements.map((item) => item.id) : []),
    [homeBlock.announcements]
  );
  const { dismissed, onAnnouncementDismiss } = useDismissedAnnouncements(announcementIds);

  if (!homeBlock.announcements) {
    return null;
  }

  const metadata = homeBlock.metadata as HomeBlockMetaSchema;
  const announcements = homeBlock.announcements.filter((announcement) => {
    const announcementMetadata = announcement.metadata;
    const dismissible = announcementMetadata?.dismissible ?? true;

    return !dismissible || !dismissed.includes(announcement.id);
  });

  if (announcements.length === 0) {
    return null;
  }

  /**
   * Guarantees 2 announcements per row respecting their sizes.
   * If 2 announcements are not enough to fill the row, both will be half the screen.
   * Same happens if the sum of the 2 sizes is bigger than the entire screen.
   */
  const sizes = announcements
    // Get their initial sizing or -1 if size was not specified.
    .map((announcement) => {
      const announcementMetadata = announcement.metadata;

      return announcementMetadata?.colSpan ?? -1;
    })
    // Bundle these into pairs
    .reduce((acc: number[][], size, index, arr) => {
      if (index % 2 === 0) acc.push(arr.slice(index, index + 2));
      return acc;
    }, [])
    .flatMap((pair: number[]) => {
      const [a, b] = pair;

      if (!b) {
        return a === -1 ? 6 : a;
      }

      if (a === -1 && b !== -1) {
        return [12 - b, b];
      }

      if (b === -1 && a !== -1) {
        return [a, 12 - a];
      }

      return [6, 6];
    });

  return (
    <HomeBlockWrapper className={classes.root}>
      <HomeBlockHeaderMeta metadata={metadata} />
      <Grid gutter="md">
        {announcements.map((announcement, index) => {
          return (
            <Grid.Col key={announcement.id} xs={12} md={sizes[index]}>
              <AnnouncementHomeBlockAnnouncementItem
                onAnnouncementDismiss={onAnnouncementDismiss}
                announcement={announcement}
              />
            </Grid.Col>
          );
        })}
      </Grid>
    </HomeBlockWrapper>
  );
};
