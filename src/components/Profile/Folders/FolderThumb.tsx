import { useBrowsingLevelContext } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import type { FolderItem } from '~/components/Profile/Folders/folder.utils';
import { folderItemCover } from '~/components/Profile/Folders/folder.utils';
import { Flags } from '~/shared/utils/flags';
import { MediaType } from '~/shared/utils/prisma/enums';

/** A small picture for an item, blurred to its hash where the viewer blurs that level. */
export function FolderThumb({ item }: { item: FolderItem }) {
  const { blurLevels } = useBrowsingLevelContext();
  const cover = folderItemCover(item);
  if (!cover?.url) return <span className="block size-full bg-gray-3 dark:bg-dark-4" />;
  if (Flags.hasFlag(blurLevels, cover.nsfwLevel ?? 0))
    return <MediaHash hash={cover.hash} width={cover.width} height={cover.height} />;
  return (
    <EdgeMedia
      src={cover.url}
      type={(cover.type as MediaType) ?? MediaType.image}
      width={96}
      anim={false}
      className="size-full object-cover"
    />
  );
}
