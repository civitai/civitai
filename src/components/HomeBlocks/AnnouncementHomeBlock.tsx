import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { HomeBlockGetAll } from '~/types/router';

type Props = { homeBlock: HomeBlockGetAll[number] };

export const AnnouncementHomeBlock = ({ homeBlock }: Props) => {
  if (!homeBlock.announcements) {
    return null;
  }

  console.log(homeBlock.announcements);

  return <HomeBlockWrapper>Display announcements component</HomeBlockWrapper>;
};
