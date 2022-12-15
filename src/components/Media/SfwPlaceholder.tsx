import { useSfwContext } from '~/components/Media/sfwContext';

export function SfwPlaceholder({ children = null }: { children?: React.ReactNode | null }) {
  const { nsfw, showNsfw } = useSfwContext();

  if (!nsfw) return null;
  return nsfw && !showNsfw ? <>{children}</> : null;
}
