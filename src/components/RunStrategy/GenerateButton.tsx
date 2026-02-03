import type { ButtonProps } from '@mantine/core';
import { Badge, Button, Group, Text, Tooltip, useMantineTheme } from '@mantine/core';
import { IconBolt, IconBrush } from '@tabler/icons-react';
import React from 'react';
import {
  BidModelButton,
  getEntityDataForBidModelButton,
} from '~/components/Auction/BidModelButton';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { Availability, ModelStatus } from '~/shared/utils/prisma/enums';
import { useGenerationPanelStore } from '~/store/generation-panel.store';
import { generationGraphPanel } from '~/store/generation-graph.store';
import type { ModelById } from '~/types/router';
import { abbreviateNumber } from '~/utils/number-helpers';

export function GenerateButton({
  iconOnly,
  mode = 'replace',
  children,
  generationPrice,
  onPurchase,
  onClick,
  epochNumber,
  versionId,
  canGenerate,
  model,
  version,
  image,
  ...buttonProps
}: Props) {
  const theme = useMantineTheme();
  const features = useFeatureFlags();

  const vId = versionId ?? version?.id;

  const opened = useGenerationPanelStore((state) => state.opened);
  const onClickHandler = () => {
    if (generationPrice) {
      onPurchase?.();
      return;
    }
    if (mode === 'toggle' && opened) return generationGraphPanel.close();

    vId
      ? generationGraphPanel.open({
          type: 'modelVersion',
          id: vId,
          epoch: epochNumber,
        })
      : generationGraphPanel.open();

    onClick?.();
  };

  if (children)
    return React.cloneElement(children, {
      ...buttonProps,
      onClick: onClickHandler,
      style: { cursor: 'pointer' },
    });

  const purchaseIcon = (
    <Badge
      radius="sm"
      size="sm"
      variant="filled"
      color="yellow.7"
      style={{
        position: 'absolute',
        top: '-8px',
        right: '-8px',
        boxShadow: theme.shadows.sm,
        padding: '4px 2px',
        paddingRight: '6px',
      }}
    >
      <Group gap={0} wrap="nowrap">
        <IconBolt style={{ fill: theme.colors.dark[9] }} color="dark.9" size={14} />{' '}
        <Text size="xs" fz={11} c="dark.9">
          {abbreviateNumber(generationPrice ?? 0, { decimals: 0 })}
        </Text>
      </Group>
    </Badge>
  );

  const cannotPromote = model?.meta?.cannotPromote ?? false;
  const isAvailable = model?.availability !== Availability.Private;
  const isPublished = model?.status === ModelStatus.Published;
  const isPoi = model?.poi ?? false;

  const showBid =
    features.auctions && !canGenerate && isAvailable && isPublished && !cannotPromote && !isPoi;

  if (!showBid && !canGenerate) return null;

  const popButton = showBid ? (
    <BidModelButton
      entityData={getEntityDataForBidModelButton({
        version,
        model,
        image,
      })}
      asButton
      buttonProps={{
        ...buttonProps,
        className: 'pl-[8px] pr-[12px] w-full',
        color: 'cyan',
      }}
      divProps={{ className: 'flex-[2]' }}
    />
  ) : (
    <Button
      variant="filled"
      className="overflow-visible"
      style={iconOnly ? { paddingRight: 0, paddingLeft: 0, width: 36 } : { flex: 1 }}
      onClick={onClickHandler}
      {...buttonProps}
    >
      {generationPrice && <>{purchaseIcon}</>}
      {iconOnly ? (
        <IconBrush size={24} />
      ) : (
        <Group gap={8} wrap="nowrap">
          <IconBrush size={20} />
          <Text inherit inline className="hide-mobile">
            Create
          </Text>
        </Group>
      )}
    </Button>
  );

  return iconOnly ? (
    <Tooltip label="Start Generating" withArrow>
      {popButton}
    </Tooltip>
  ) : (
    popButton
  );
}
type PropsBase = Omit<ButtonProps, 'onClick' | 'children'> & {
  iconOnly?: boolean;
  mode?: 'toggle' | 'replace';
  children?: React.ReactElement;
  generationPrice?: number;
  onPurchase?: () => void;
  onClick?: () => void;
  epochNumber?: number;
  image?: ImagesInfiniteModel;
  versionId?: number;
};

type Props =
  | (PropsBase & {
      canGenerate: true;
      model?: ModelById;
      version?: ModelById['modelVersions'][number];
    })
  | (PropsBase & {
      canGenerate: false;
      model: ModelById;
      version: ModelById['modelVersions'][number];
    });
