import { useEffect, useRef, useState, type ReactNode } from 'react';
import { serviceCardId } from '~/components/CreatorShop/section-meta';

/** Scrolls to and outlines its card when the page was opened on `#service-<id>`; does nothing without that hash. */
export function ServiceCardAnchor({
  offeringId,
  children,
}: {
  offeringId: number;
  children: ReactNode;
}) {
  const id = serviceCardId(offeringId);
  const ref = useRef<HTMLDivElement>(null);
  const [targeted, setTargeted] = useState(false);

  useEffect(() => {
    if (window.location.hash !== `#${id}`) return;
    setTargeted(true);
    ref.current?.scrollIntoView({ block: 'center' });
  }, [id]);

  return (
    <div
      ref={ref}
      id={id}
      className="h-full scroll-mt-20 rounded-md"
      style={targeted ? { outline: '2px solid var(--mantine-color-yellow-5)' } : undefined}
    >
      {children}
    </div>
  );
}
