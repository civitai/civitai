import React from 'react';
import { HomeBlockExtended } from '~/server/controllers/home-block.controller';
import HomeBlockWrapper from '~/components/HomeBlocks/HomeBlockWrapper';

type Props = { homeBlock: HomeBlockExtended };

const AnnouncementHomeBlock = ({ homeBlock }: Props) => {
  if (!homeBlock.announcements) {
    return null;
  }

  console.log(homeBlock.announcements);

  return <HomeBlockWrapper>Display announcements component</HomeBlockWrapper>;
};

export default AnnouncementHomeBlock;
