// import { CloseButton, Popover, PopoverButton, PopoverPanel } from '@headlessui/react';
// import type { ButtonProps } from '@mantine/core';
// import { Button, Card, Divider, Group } from '@mantine/core';
// import { IconBrush } from '@tabler/icons-react';
import dynamic from 'next/dynamic';
// import React from 'react';
// import { CopyButton } from '~/components/CopyButton/CopyButton';
// import { ImageMeta } from '~/components/Image/DetailV2/ImageMeta';
// import { useIsClient } from '~/providers/IsClientProvider';
// import type { MediaType } from '~/shared/utils/prisma/enums';
// import { generationPanel } from '~/store/generation.store';
// import { encodeMetadata } from '~/utils/metadata';
// import { trpc } from '~/utils/trpc';

export const ImageMetaPopover2 = dynamic(
  () => import('~/components/Image/Meta/ImageMetaPopoverLazy')
);

// export function ImageMetaPopover2({
//   imageId,
//   children,
//   type,
// }: {
//   imageId: number;
//   children: React.ReactElement;
//   type: MediaType;
//   // TODO - accept meta props
// }) {
//   const isClient = useIsClient();
//   if (!isClient) return children;

//   return (
//     <Popover className="relative flex items-center">
//       <PopoverButton className="flex cursor-pointer items-center justify-center border-none bg-transparent">
//         {children}
//       </PopoverButton>
//       <PopoverPanel
//         className="z-[500]"
//         anchor="top end"
//         onClick={(e) => {
//           e.preventDefault();
//           e.stopPropagation();
//         }}
//       >
//         <Card withBorder className="flex w-96 max-w-full flex-col gap-3 rounded-xl">
//           <ImageMetaPopoverInner imageId={imageId} />
//         </Card>
//       </PopoverPanel>
//     </Popover>
//   );
// }

// const sharedButtonProps: ButtonProps = {
//   size: 'xs',
//   variant: 'light',
//   classNames: { inner: 'flex gap-1' },
// };

// function ImageMetaPopoverInner({ imageId }: { imageId: number }) {
//   const { data, isLoading } = trpc.image.getGenerationData.useQuery({ id: imageId });

//   if (isLoading) {
//     const Skeleton = (
//       <>
//         <div className="h-3 w-32 rounded-full bg-gray-200 dark:bg-gray-700"></div>
//         <div className="flex flex-col gap-2">
//           {Array(3)
//             .fill(0)
//             .map((_, i) => (
//               <div key={i} className="h-2.5 rounded-full bg-gray-200 dark:bg-gray-700"></div>
//             ))}
//           <div className="h-2.5 w-56 rounded-full bg-gray-200 dark:bg-gray-700"></div>
//         </div>
//       </>
//     );

//     return (
//       <div className="flex animate-pulse flex-col gap-3">
//         {Skeleton}
//         <Divider />
//         {Skeleton}
//       </div>
//     );
//   }

//   const { meta, canRemix, type = 'image' } = data ?? {};

//   return (
//     <>
//       <ImageMeta imageId={imageId} />
//       <Button.Group>
//         {canRemix && (
//           <Button
//             as={CloseButton}
//             {...sharedButtonProps}
//             data-activity="remix:image-meta"
//             // @ts-ignore eslint-disable-next-line
//             onClick={() => {
//               generationPanel.open({ type, id: imageId ?? 0 });
//             }}
//             className="flex-1"
//           >
//             <Group gap={4} align="center">
//               <IconBrush size={16} />
//               Remix
//             </Group>
//           </Button>
//         )}
//         {meta && (
//           <CopyButton value={() => encodeMetadata(meta)}>
//             {({ copy, copied, color, Icon }) => (
//               <Button {...sharedButtonProps} className="-ml-px" onClick={copy} color={color}>
//                 <Icon size={16} />
//                 {!canRemix && (!copied ? 'Copy Generation Data' : 'Copied')}
//               </Button>
//             )}
//           </CopyButton>
//         )}
//       </Button.Group>
//     </>
//   );
// }
