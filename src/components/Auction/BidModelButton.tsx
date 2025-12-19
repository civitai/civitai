import type { ActionIconProps, ButtonProps } from '@mantine/core';
import { Button, Group, Text, Tooltip } from '@mantine/core';
import { IconGavel } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useMemo } from 'react';
import { useAuctionContext } from '~/components/Auction/AuctionProvider';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ModelMeta } from '~/server/schema/model.schema';
import type { GetAuctionBySlugReturn } from '~/server/services/auction.service';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { getCanAuctionForGeneration } from '~/shared/constants/base-model.constants';
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
  const canAuctionForGeneration = getCanAuctionForGeneration(entityData.baseModel);

  const destAuction = useMemo(() => {
    const modelSet = isCheckpoint ? null : getBaseModelSetType(entityData.baseModel);
    return auctions.find(
      (a) => a.auctionBase.type === AuctionType.Model && a.auctionBase.ecosystem === modelSet
    );
  }, [auctions, entityData.baseModel, isCheckpoint]);

  const handle = () => {
    if (isCheckpoint && !canAuctionForGeneration) {
      dialogStore.trigger({
        component: ConfirmDialog,
        props: {
          title: 'Please Note! ',
          message: (
            <div className="flex flex-col gap-2">
              <Text>Bidding on this model will not make it active for Generation!</Text>
              <Text>
                {entityData.baseModel} is not currently available for Generation on the Civitai
                Generator. You may still place a bid if you wish to promote this model to the Home
                Page Featured Model section.
              </Text>
            </div>
          ),
          labels: { cancel: `Cancel`, confirm: `Yes, I am sure` },
          onConfirm: setAuction,
          size: 600,
        },
      });
    } else {
      setAuction();
    }
  };

  function setAuction() {
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
  }

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
          ? isCheckpoint && canAuctionForGeneration
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
