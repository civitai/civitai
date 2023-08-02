import { AspectRatio, Group, Skeleton, Stack } from '@mantine/core';

export const CollectionHomeBlockSkeleton = () => {
  return (
    <Group spacing={12}>
      <Stack spacing={0} w="calc(50% - 12px)">
        <Group>
          <Skeleton width="30px" height="30px" mb={20} />{' '}
          <Skeleton width="60%" height="30px" mb={20} />
        </Group>
        <Skeleton width="100%" height="15px" mb={10} />
        <Skeleton width="100%" height="15px" mb={10} />
        <Skeleton width="80%" height="15px" mb={10} />
      </Stack>
      <AspectRatio ratio={7 / 9} w="calc(25% - 12px)">
        <Skeleton width="100%" height="430" />
      </AspectRatio>
      <AspectRatio ratio={7 / 9} w="calc(25% - 12px)">
        <Skeleton width="100%" height="430" />
      </AspectRatio>
    </Group>
  );
};
