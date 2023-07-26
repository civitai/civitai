import { HomeBlockWrapper } from '~/components/HomeBlocks/HomeBlockWrapper';
import { AspectRatio, Group, Skeleton, Stack } from '@mantine/core';

export const CollectionHomeBlockSkeleton = () => {
  return (
    <HomeBlockWrapper py="md">
      <Group spacing={12}>
        <Stack spacing={0} w="calc(50% - 12px)">
          <Skeleton width="60%" height="50px" mb={20} />
          <Skeleton width="100%" height="10px" mb={10} />
          <Skeleton width="100%" height="10px" mb={10} />
          <Skeleton width="80%" height="10px" mb={10} />
        </Stack>
        <AspectRatio ratio={7 / 9} w="calc(25% - 12px)">
          <Skeleton width="100%" height="430" />
        </AspectRatio>
        <AspectRatio ratio={7 / 9} w="calc(25% - 12px)">
          <Skeleton width="100%" height="430" />
        </AspectRatio>
      </Group>
    </HomeBlockWrapper>
  );
};
