import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { HomeBlockGetAll } from '~/types/router';

type Props = { homeBlock: HomeBlockGetAll[number] };

export const CollectionHomeBlock = ({ homeBlock }: Props) => {
  if (!homeBlock.collection) {
    return null;
  }

  return (
    <HomeBlockWrapper>
      Display collection component depending on the collection items type
    </HomeBlockWrapper>
  );
};
