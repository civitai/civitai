import { IconX } from '@tabler/icons-react';
import { RewardsBonusBanner } from '~/components/Buzz/RewardsBonusBanner';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import {
  useNavBannersDismissed,
  visibleNavBanners,
} from '~/components/AppLayout/NavAnnouncementSlot/nav-banners-dismissed';
import { NAV_BANNERS_STALE_TIME } from '~/providers/AppProvider';
import type { NavBanner } from '~/shared/constants/nav-banner.constants';
import { trpc } from '~/utils/trpc';

const DEFAULT_BACKGROUND = '#1a1b1e';

/**
 * The strips at the top of the sub-nav: the Buzz Bonus notice, then the highest-priority event
 * banner. Event banners come from event definitions (`banner`), are seeded by the SSR settings
 * bootstrap, and so are in the first paint.
 */
export function NavAnnouncementSlot() {
  return (
    <>
      <RewardsBonusBanner />
      <EventNavBanners />
    </>
  );
}

function EventNavBanners() {
  const { data = [] } = trpc.event.getNavBanners.useQuery(undefined, {
    staleTime: NAV_BANNERS_STALE_TIME,
  });
  const { dismissed, dismiss } = useNavBannersDismissed();

  return (
    <>
      {visibleNavBanners(data, dismissed).map((banner) => (
        <NavBannerStrip key={banner.id} banner={banner} onDismiss={() => dismiss(banner.id)} />
      ))}
    </>
  );
}

export function NavBannerStrip({
  banner,
  onDismiss,
}: {
  banner: NavBanner;
  onDismiss: () => void;
}) {
  const background = banner.background ?? DEFAULT_BACKGROUND;

  return (
    <div
      className="relative isolate flex h-11 w-full items-center overflow-hidden text-white"
      style={{ backgroundColor: background }}
      data-testid="nav-banner"
    >
      {banner.image && (
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <EdgeImage
            src={banner.image}
            options={{ width: 450 }}
            hiDpi
            alt=""
            className="absolute right-0 top-1/2 h-[260%] w-auto max-w-none translate-y-[-54%] sm:right-[4%]"
          />
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `linear-gradient(90deg, ${background} 0%, ${background} 45%, transparent 90%)`,
            }}
          />
        </div>
      )}
      <Link
        href={banner.href}
        className="flex h-full min-w-0 flex-1 items-center gap-3 pl-4 text-white no-underline focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
      >
        <span className="flex min-w-0 flex-1 items-baseline gap-2.5 overflow-hidden whitespace-nowrap [text-shadow:0_1px_3px_rgba(0,0,0,0.5)]">
          <span className="truncate text-sm font-extrabold sm:shrink-0">
            {banner.title}
            {banner.accent && <span className="text-yellow-4"> {banner.accent}</span>}
          </span>
          {banner.text && (
            <span className="hidden truncate text-[13px] text-white/80 sm:inline">
              {banner.text}
            </span>
          )}
        </span>
        {banner.cta && (
          <span className="hidden shrink-0 rounded-full bg-white px-3 py-1 text-xs font-bold text-dark-9 sm:inline">
            {banner.cta}
          </span>
        )}
      </Link>
      {banner.dismissible ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss ${banner.title}`}
          className="flex h-full w-10 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent text-white/70 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white"
        >
          <IconX size={18} />
        </button>
      ) : (
        <span className="w-3 shrink-0" />
      )}
    </div>
  );
}
