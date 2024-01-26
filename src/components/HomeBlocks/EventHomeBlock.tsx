import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { HomeBlockMetaSchema } from '~/server/schema/home-block.schema';

export function EventHomeBlock({ showAds, ...props }: Props) {
  if (!props.metadata.event) return null;

  return (
    <HomeBlockWrapper py={32} showAds={showAds}>
      <EventHomeBlockContent {...props} />
    </HomeBlockWrapper>
  );
}

function EventHomeBlockContent({ metadata }: Props) {
  // TODO Manuel: Implement EventHomeBlockContent
  return null;
}

type Props = { metadata: HomeBlockMetaSchema; showAds?: boolean };
