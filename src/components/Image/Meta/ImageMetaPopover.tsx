import { Divider, Card, Button, ButtonProps } from '@mantine/core';

import { CopyButton } from '~/components/CopyButton/CopyButton';
import { trpc } from '~/utils/trpc';
import { CloseButton, Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
import React from 'react';
import { IconBrush } from '@tabler/icons-react';
import { generationPanel } from '~/store/generation.store';
import { encodeMetadata } from '~/utils/metadata';
import { ImageMeta } from '~/components/Image/DetailV2/ImageMeta';

export function ImageMetaPopover2({
  imageId,
  children,
}: {
  imageId: number;
  children: React.ReactElement;
}) {
  return (
    <Popover className="relative">
      <PopoverButton>{children}</PopoverButton>
      <PopoverPanel
        className="z-10"
        anchor="top end"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <Card withBorder className="flex w-96 max-w-full flex-col gap-3 rounded-xl">
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
        <div className="h-3 w-32 rounded-full bg-gray-200 dark:bg-gray-700"></div>
        <div className="flex flex-col gap-2">
          {Array(3)
            .fill(0)
            .map((_, i) => (
              <div key={i} className="h-2.5 rounded-full bg-gray-200 dark:bg-gray-700"></div>
            ))}
          <div className="h-2.5 w-56 rounded-full bg-gray-200 dark:bg-gray-700"></div>
        </div>
      </>
    );

    return (
      <div className="flex animate-pulse flex-col gap-3">
        {Skeleton}
        <Divider />
        {Skeleton}
      </div>
    );
  }

  const { meta, canRemix } = data ?? {};

  return (
    <>
      <ImageMeta imageId={imageId} />
      <Button.Group>
        {canRemix && (
          <CloseButton
            as={Button}
            {...sharedButtonProps}
            data-activity="remix:image-meta"
            // @ts-ignore eslint-disable-next-line
            onClick={() => {
              generationPanel.open({ type: 'image', id: imageId ?? 0 });
            }}
            className="flex-1"
          >
            <IconBrush size={16} />
            Remix
          </CloseButton>
        )}
        {meta && (
          <CopyButton value={() => encodeMetadata(meta)}>
            {({ copy, copied, color, Icon }) => (
              <Button {...sharedButtonProps} onClick={copy} color={color}>
                <Icon size={16} />
                {!canRemix && (!copied ? 'Copy Generation Data' : 'Copied')}
              </Button>
            )}
          </CopyButton>
        )}
      </Button.Group>
    </>
  );
}
