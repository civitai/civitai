import { Divider, Card, Button, ButtonProps } from '@mantine/core';

import { CopyButton } from '~/components/CopyButton/CopyButton';
import { trpc } from '~/utils/trpc';
import { CloseButton, Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import React from 'react';
import { IconBrush } from '@tabler/icons-react';
import { generationPanel } from '~/store/generation.store';
import { encodeMetadata } from '~/utils/metadata';
import { ImageMeta } from '~/components/Image/DetailV2/ImageMeta';
import { useIsClient } from '~/providers/IsClientProvider';
import { MediaType } from '~/shared/utils/prisma/enums';
import styles from './ImageMetaPopover.module.scss';

export function ImageMetaPopover2({
  imageId,
  children,
  type,
}: {
  imageId: number;
  children: React.ReactElement;
  type: MediaType;
  // TODO - accept meta props
}) {
  const isClient = useIsClient();
  if (!isClient) return children;

  return (
    <Popover className={styles.popover}>
      <PopoverButton>{children}</PopoverButton>
      <PopoverPanel
        className={styles.popoverPanel}
        anchor="top end"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <Card withBorder className={styles.card}>
          <ImageMetaPopoverInner imageId={imageId} />
        </Card>
      </PopoverPanel>
    </Popover>
  );
}

const sharedButtonProps: ButtonProps = {
  size: 'xs',
  variant: 'light',
  classNames: { inner: 'flex gap-1' },
};

function ImageMetaPopoverInner({ imageId }: { imageId: number }) {
  const { data, isLoading } = trpc.image.getGenerationData.useQuery({ id: imageId });

  if (isLoading) {
    const Skeleton = (
      <>
        <div className={`${styles.skeletonLine} ${styles.skeletonLineShort}`}></div>
        <div className={styles.skeleton}>
          {Array(3)
            .fill(0)
            .map((_, i) => (
              <div key={i} className={styles.skeletonLine}></div>
            ))}
          <div className={`${styles.skeletonLine} ${styles.skeletonLineLong}`}></div>
        </div>
      </>
    );

    return (
      <div className={styles.skeleton}>
        {Skeleton}
        <Divider />
        {Skeleton}
      </div>
    );
  }

  const { meta, canRemix, type = 'image' } = data ?? {};

  return (
    <>
      <ImageMeta imageId={imageId} />
      <div className={styles.buttonGroup}>
        {canRemix && (
          <CloseButton
            as={Button}
            {...sharedButtonProps}
            data-activity="remix:image-meta"
            onClick={() => {
              generationPanel.open({ type, id: imageId ?? 0 });
            }}
            className={`${styles.button} ${styles.buttonRemix}`}
          >
            <IconBrush size={16} className={styles.buttonIcon} />
            Remix
          </CloseButton>
        )}
        {meta && (
          <CopyButton value={() => encodeMetadata(meta)}>
            {({ copy, copied, color, Icon }) => (
              <Button
                {...sharedButtonProps}
                onClick={copy}
                className={`${styles.button} ${styles.buttonCopy}`}
              >
                <Icon size={16} className={styles.buttonIcon} />
                {!canRemix && (!copied ? 'Copy Generation Data' : 'Copied')}
              </Button>
            )}
          </CopyButton>
        )}
      </div>
    </>
  );
}

