import { Box, Center, Group, Loader, Stack, Text, UnstyledButton } from '@mantine/core';
import { useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { CreatorCardV2 } from '~/components/CreatorCard/CreatorCard';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { PreviewCard } from '~/components/Modals/CardDecorationModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import type { CosmeticGetById } from '~/types/router';
import { trpc } from '~/utils/trpc';

/**
 * Live preview of a cosmetic (badge / nameplate / profile decoration / content
 * decoration). Pure client component — extracted out of the
 * `pages/moderator/cosmetic-store/cosmetics` page so client consumers (e.g.
 * `CosmeticShopItemPreviewModal`) can render it WITHOUT importing the page
 * module, whose `getServerSideProps` transitively pulls the tRPC appRouter (and
 * thus server-only natives like `sharp`) into the client/test bundle.
 */
export const CosmeticPreview = ({
  cosmetic,
}: {
  cosmetic: Pick<CosmeticGetById, 'id' | 'data' | 'type' | 'name' | 'source' | 'description'>;
}) => {
  const isProfileRelated =
    cosmetic.type === CosmeticType.Badge ||
    cosmetic.type === CosmeticType.NamePlate ||
    cosmetic.type === CosmeticType.ProfileBackground ||
    cosmetic.type === CosmeticType.ProfileDecoration;

  const currentUser = useCurrentUser();
  const { data: user } = trpc.userProfile.get.useQuery(
    { username: currentUser ? currentUser.username : '' },
    { enabled: !!currentUser?.username && isProfileRelated }
  );
  const browsingLevel = useBrowsingLevelDebounced();
  const { data: images = [] } = trpc.cosmeticShop.getPreviewImages.useQuery(
    {
      browsingLevel: browsingLevel,
    },
    {
      enabled: !!currentUser && !isProfileRelated,
    }
  );
  const [activeImageIndex, setActiveImageIndex] = useState(0);

  if ((!user && isProfileRelated) || (!images && !isProfileRelated)) {
    return (
      <Center>
        <Loader />
      </Center>
    );
  }

  const userWithEquippedCosmetics = user
    ? {
        ...user,
        cosmetics: user?.cosmetics?.filter((c) => !!c.equippedAt) ?? [],
      }
    : undefined;

  switch (cosmetic.type) {
    case CosmeticType.Badge:
    case CosmeticType.ProfileDecoration:
    case CosmeticType.NamePlate:
    case CosmeticType.ProfileBackground:
      if (!userWithEquippedCosmetics) {
        return null;
      }

      return (
        <Stack gap="xl">
          <Text fw="bold" align="center">
            Preview
          </Text>
          <CreatorCardV2 user={userWithEquippedCosmetics} cosmeticOverwrites={[cosmetic]} />
        </Stack>
      );
    case CosmeticType.ContentDecoration:
      if (!images.length) {
        return null;
      }

      return (
        <Stack>
          <Stack gap="xl">
            <Text fw="bold" align="center">
              Preview
            </Text>
            <Text size="sm" c="dimmed" align="center">
              You can apply this cosmetic to any image, model, article or post you own.
            </Text>
          </Stack>
          <Box mx="auto">
            <PreviewCard
              decoration={cosmetic as ContentDecorationCosmetic}
              image={images[activeImageIndex]}
            />
          </Box>
          <Group gap="xs" justify="center">
            {images.map((image, index) => {
              const isSelected = index === activeImageIndex;
              return (
                <UnstyledButton
                  key={image.id}
                  onClick={() => setActiveImageIndex(index)}
                  style={{
                    opacity: isSelected ? 1 : 0.5,
                    width: 40,
                    height: 50,
                    borderRadius: 5,
                    overflow: 'hidden',
                  }}
                >
                  <EdgeMedia
                    style={{ objectFit: 'cover', width: '100%', height: '100%' }}
                    src={image.url}
                    width={100}
                  />
                </UnstyledButton>
              );
            })}
          </Group>{' '}
        </Stack>
      );
    default:
      return null;
  }
};
