import React from 'react';
import { HomeBlockExtended } from '~/server/controllers/home-block.controller';

type Props = { homeBlock: HomeBlockExtended };

const AnnouncementHomeBlock = ({ homeBlock }: Props) => {
  if (!homeBlock.announcements) {
    return null;
  }

  console.log(homeBlock.announcements);

  return <div>Display announcements component</div>;
};

export default AnnouncementHomeBlock;
