import { IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import type { CSSProperties } from 'react';
import { RewardsBonusBanner } from '~/components/Buzz/RewardsBonusBanner';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import { dismissHint } from '~/components/Events/event-promos';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { SiteAlertStrips } from '~/components/SiteAlerts/SiteAlertStrips';
import {
  useNavBannersDismissed,
  visibleNavBanners,
} from '~/components/AppLayout/NavAnnouncementSlot/nav-banners-dismissed';
import { NAV_BANNERS_STALE_TIME } from '~/providers/AppProvider';
import type { NavBanner } from '~/shared/constants/nav-banner.constants';
import { showInfoNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const DEFAULT_BACKGROUND = '#1a1b1e';

/**
 * The strips at the top of the sub-nav: site alerts for the current path, the Buzz Bonus notice,
 * then the highest-priority event banner. Event banners come from event definitions (`banner`), are seeded by the SSR settings
 * bootstrap, and so are in the first paint.
 */
export function NavAnnouncementSlot() {
  return (
    <>
      <SiteAlertStrips />
      <RewardsBonusBanner />
      <EventNavBanners />
    </>
  );
}

export function EventNavBanners() {
  const { data = [] } = trpc.event.getNavBanners.useQuery(undefined, {
    staleTime: NAV_BANNERS_STALE_TIME,
  });
  const { dismissed, dismiss } = useNavBannersDismissed();

  return (
    <>
      {visibleNavBanners(data, dismissed).map((banner) => (
        <NavBannerStrip
          key={banner.id}
          banner={banner}
          onDismiss={() => {
            dismiss(banner.id);
            const hint = dismissHint(banner, data);
            if (hint)
              showInfoNotification({
                id: `${banner.id}:dismissed`,
                title: 'Hidden',
                message: hint,
                autoClose: 6000,
              });
          }}
        />
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
  const { theme } = banner;
  const themeVars = theme && {
    '--nb-text': theme.text,
    '--nb-muted': theme.mutedText,
    '--nb-accent': theme.accent,
    '--nb-cta-bg': theme.ctaBackground,
    '--nb-cta-text': theme.ctaText,
  };

  return (
    <div
      className={clsx(
        'relative isolate flex h-11 w-full items-center overflow-hidden',
        theme ? 'text-[var(--nb-text)]' : 'text-white'
      )}
      style={{ backgroundColor: background, ...themeVars } as CSSProperties}
      data-testid="nav-banner"
    >
      {banner.image && (
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          {/* Sits just left of the CTA and dismiss button, fading in from the strip's colour. */}
          <EdgeImage
            src={banner.image}
            options={{ width: 450 }}
            hiDpi
            alt=""
            className={clsx(
              'absolute right-8 top-1/2 h-[260%] w-auto max-w-none translate-y-[-54%] [mask-image:linear-gradient(to_right,transparent,black_70%)] sm:[mask-image:linear-gradient(to_right,transparent,black_45%)]',
              banner.cta && 'sm:right-36'
            )}
          />
        </div>
      )}
      <Link
        href={banner.href}
        className={clsx(
          'flex h-full min-w-0 flex-1 items-center gap-3 pl-4 no-underline focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white',
          theme ? 'text-[var(--nb-text)]' : 'text-white'
        )}
      >
        <span className="flex min-w-0 flex-1 items-baseline gap-2.5 overflow-hidden whitespace-nowrap [text-shadow:0_1px_3px_rgba(0,0,0,0.5)]">
          <span className="truncate text-sm font-extrabold sm:shrink-0">
            {banner.title}
            {banner.accent && (
              <span className={theme ? 'text-[var(--nb-accent)]' : 'text-yellow-4'}>
                {' '}
                {banner.accent}
              </span>
            )}
          </span>
          {banner.text && (
            <span
              className={clsx(
                'hidden truncate text-[13px] sm:inline',
                theme ? 'text-[var(--nb-muted)]' : 'text-white/80'
              )}
            >
              {banner.text}
            </span>
          )}
        </span>
        {banner.cta && (
          <span
            className={clsx(
              'hidden shrink-0 rounded-full px-3 py-1 text-xs font-bold sm:inline',
              theme ? 'bg-[var(--nb-cta-bg)] text-[var(--nb-cta-text)]' : 'bg-white text-dark-9'
            )}
          >
            {banner.cta}
          </span>
        )}
      </Link>
      {banner.dismissible ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss ${banner.title}`}
          className={clsx(
            'flex h-full w-10 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-white',
            theme
              ? 'text-[var(--nb-muted)] hover:text-[var(--nb-text)]'
              : 'text-white/70 hover:text-white'
          )}
        >
          <IconX size={18} />
        </button>
      ) : (
        <span className="w-3 shrink-0" />
      )}
    </div>
  );
}
