import type { ActionIconProps, ButtonProps } from '@mantine/core';
import { Button, Group, Text, Tooltip } from '@mantine/core';
import { IconGavel } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useMemo } from 'react';
import { useAuctionContext } from '~/components/Auction/AuctionProvider';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ModelMeta } from '~/server/schema/model.schema';
import type { GetAuctionBySlugReturn } from '~/server/services/auction.service';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { getBaseModelSetType } from '~/shared/constants/generation.constants';
import { AuctionType, Availability, ModelType } from '~/shared/utils/prisma/enums';
import type { ModelById } from '~/types/router';
import { trpc } from '~/utils/trpc';

export const BidModelButton = ({
  entityData,
  asButton,
  buttonProps,
  actionIconProps,
  divProps,
}: {
  entityData: Exclude<GetAuctionBySlugReturn['bids'][number]['entityData'], undefined>;
  asButton?: boolean;
  buttonProps?: ButtonProps;
  actionIconProps?: ActionIconProps;
  divProps?: React.HTMLAttributes<HTMLDivElement>;
}) => {
  const { setSelectedModel } = useAuctionContext();
  const router = useRouter();
  const features = useFeatureFlags();

  const { data: auctions = [] } = trpc.auction.getAll.useQuery(undefined, {
    enabled: features.auctions,
  });

  const isCheckpoint = entityData.model.type === ModelType.Checkpoint;

  const destAuction = useMemo(() => {
    const modelSet = isCheckpoint ? null : getBaseModelSetType(entityData.baseModel);
    return auctions.find(
      (a) => a.auctionBase.type === AuctionType.Model && a.auctionBase.ecosystem === modelSet
    );
  }, [auctions, entityData.baseModel, isCheckpoint]);

  const handle = () => {
    if (!destAuction) return;

    setSelectedModel({
      ...entityData,
      strength: -1,
      minStrength: -1,
      maxStrength: -1,
      trainedWords: [],
      canGenerate: true,
      hasAccess: true,
    });

    router.push(`/auctions/${destAuction.auctionBase.slug}`).catch();
  };

  if (!features.auctions) return <></>;
  if (entityData.model.cannotPromote) return <></>;

  const actionButton = asButton ? (
    <Button onClick={handle} disabled={!destAuction} {...buttonProps}>
      <Group gap={8} wrap="nowrap">
        <IconGavel size={20} />
        <Text inherit inline className="hide-mobile">
          Bid
        </Text>
      </Group>
    </Button>
  ) : (
    <LegacyActionIcon
      onClick={handle}
      disabled={!destAuction}
      color="gray"
      variant="light"
      {...actionIconProps}
    >
      <IconGavel size={20} />
    </LegacyActionIcon>
  );

  return (
    <Tooltip
      withArrow
      withinPortal
      label={
        destAuction
          ? isCheckpoint
            ? 'Bid to feature this model and enable it for generation'
            : 'Bid to feature this model'
          : 'No auction available for this model'
      }
    >
      <div {...divProps}>{actionButton}</div>
    </Tooltip>
  );
};

export const getEntityDataForBidModelButton = ({
  version,
  model,
  image,
}: {
  version: ModelById['modelVersions'][number];
  model: ModelById;
  image: ImagesInfiniteModel | undefined;
}) => {
  return {
    // TODO these overrides are colossally stupid.
    ...version,
    model: {
      ...model,
      cannotPromote: (model.meta as ModelMeta | null)?.cannotPromote ?? false,
    },
    image: !!image
      ? {
          ...image,
          userId: image.user.id,
          name: image.name ?? '',
          width: image.width ?? 0,
          height: image.height ?? 0,
          hash: image.hash ?? '',
          modelVersionId: image.modelVersionId ?? 0,
          tags: image.tags ? image.tags.map((t) => t.id) : [],
          availability: image.availability ?? Availability.Public,
        }
      : undefined,
  };
};
