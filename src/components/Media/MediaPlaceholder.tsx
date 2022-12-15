import { useMediaContext } from '~/components/Media/mediaContext';

export function MediaPlaceholder({ children = null }: { children?: React.ReactNode | null }) {
  const { nsfw, showNsfw } = useMediaContext();

  if (!nsfw) return null;
  return nsfw && !showNsfw ? <>{children}</> : null;
}
