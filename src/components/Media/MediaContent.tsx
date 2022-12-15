import { useMediaContext } from '~/components/Media/mediaContext';

export function MediaContent({ children }: { children?: React.ReactNode }) {
  const { nsfw, showNsfw } = useMediaContext();

  if (nsfw) {
    if (showNsfw) return <>{children}</>;
    else return null;
  }

  return <>{children}</>;
}
