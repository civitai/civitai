import { useEffect, useState } from 'react';
import classes from '~/components/HatTurf/HatTurfLayer.module.css';
import { formatTimeLeft } from '~/components/HatTurf/hat-turf.utils';
import { useHatStock } from '~/components/HatTurf/useHatTurf';
import { stickerExpiresAt } from '~/server/events/turf/schedule';
import { trpc } from '~/utils/trpc';

const TICK_MS = 60_000;

/** How long the viewer's own hat keeps counting. Nothing while hats do not expire. */
export function HatTimeLeft({
  placedAt,
  className = classes.timeLeft,
}: {
  placedAt: Date | string | null | undefined;
  /** Replaces the label under a hat. */
  className?: string;
}) {
  const stock = useHatStock();
  const utils = trpc.useUtils();
  const expiresAt =
    placedAt && stock?.expiry ? stickerExpiresAt(new Date(placedAt), stock.expiry) : null;
  const expiresMs = expiresAt?.getTime() ?? null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresMs === null) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [expiresMs]);
  const expired = expiresMs !== null && expiresMs <= now;
  useEffect(() => {
    if (!expired) return;
    // The server no longer draws it: reread, so it leaves and placing here is offered again.
    void utils.hatTurf.getStickersForImages.invalidate();
    void utils.hatTurf.getImageStickers.invalidate();
  }, [expired, utils]);
  if (expiresMs === null || expired) return null;
  return (
    <span
      className={className}
      data-testid="hat-turf-time-left"
      title={`Your hat counts until ${new Date(expiresMs).toLocaleString()}`}
    >
      {formatTimeLeft(expiresMs - now)}
    </span>
  );
}
