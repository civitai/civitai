import React from 'react';
import { HomeBlockExtended } from '~/server/controllers/home-block.controller';

type Props = { homeBlock: HomeBlockExtended };

const CollectionHomeBlock = ({ homeBlock }: Props) => {
  if (!homeBlock.collection) {
    return null;
  }

  console.log(homeBlock.collection);

  return <div>Display collection component depending on the collection items type</div>;
};

export default CollectionHomeBlock;
