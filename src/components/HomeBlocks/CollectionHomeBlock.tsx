import React from 'react';
import { HomeBlockExtended } from '~/server/controllers/home-block.controller';
import HomeBlockWrapper from '~/components/HomeBlocks/HomeBlockWrapper';

type Props = { homeBlock: HomeBlockExtended };

const CollectionHomeBlock = ({ homeBlock }: Props) => {
  if (!homeBlock.collection) {
    return null;
  }

  console.log(homeBlock.collection);

  return (
    <HomeBlockWrapper>
      Display collection component depending on the collection items type
    </HomeBlockWrapper>
  );
};

export default CollectionHomeBlock;
