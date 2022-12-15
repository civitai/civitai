import { useSfwContext } from '~/components/Media/sfwContext';

export function SfwContent({ children }: { children?: React.ReactNode }) {
  const { nsfw, showNsfw } = useSfwContext();

  if (nsfw) {
    if (showNsfw) return <>{children}</>;
    else return null;
  }

  return <>{children}</>;
}
