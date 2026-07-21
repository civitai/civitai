import type { ReactNode } from 'react';
import { MasonryContainer } from '~/components/MasonryColumns/MasonryContainer';

// Full-bleed section band: the outer div spans full content width; the inner MasonryContainer
// re-centers content to the max column width (homepage HomeBlockWrapper shape). The alternating
// band background is painted by the parent container (see index.module.css `.sections`), mirroring
// the home page's home-block treatment — no per-band prop needed.
export function SectionBand({ children }: { children: ReactNode }) {
  return (
    <div>
      <MasonryContainer py={32}>{children}</MasonryContainer>
    </div>
  );
}
