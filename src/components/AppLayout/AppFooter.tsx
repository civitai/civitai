import { Button, Indicator, Text } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconArrowUp } from '@tabler/icons-react';
import clsx from 'clsx';
import { useRef, useState } from 'react';
import { AssistantButton } from '~/components/Assistant/AssistantButton';
import { ManageConsentFooterLink } from '~/components/Consent/ManageConsentFooterLink';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { SocialLinks } from '~/components/SocialLinks/SocialLinks';
import { useDomainColor } from '~/hooks/useDomainColor';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ColorDomain } from '~/shared/constants/domain.constants';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { trpc } from '~/utils/trpc';

const footerLinks: (React.ComponentProps<typeof Button<typeof Link>> & {
  domains?: ColorDomain[];
  features?: (features: FeatureAccess) => boolean;
  key: string;
  indicator?: boolean;
})[] = [
  {
    key: 'tos',
    href: '/content/tos',
    children: 'Terms of Service',
  },
  {
    key: 'privacy',
    href: '/content/privacy',
    children: 'Privacy',
  },
  {
    key: 'safety',
    href: '/safety',
    children: 'Safety',
    features: (features) => features.safety,
  },
  // {
  //   key: 'newsroom',
  //   href: '/newsroom',
  //   children: 'Newsroom',
  //   features: (features) => features.newsroom,
  // },
  {
    key: 'api',
    href: 'https://developer.civitai.com/',
    target: '_blank',
    rel: 'nofollow noreferrer',
    children: 'API',
  },
  {
    key: 'status',
    href: 'https://status.civitai.com',
    target: '_blank',
    rel: 'nofollow noreferrer',
    children: 'Status',
  },
  {
    key: 'issues',
    href: '/issues',
    children: 'Known Issues',
    indicator: true,
    features: (features) => features.bugsPage,
  },
  {
    key: 'education',
    href: '/education',
    target: '_blank',
    rel: 'nofollow noreferrer',
    children: 'Education',
  },
  {
    key: 'creator-program',
    href: '/creator-program',
    color: 'blue',
    children: 'Creators',
  },
  {
    key: 'advertising',
    href: 'https://advertising.civitai.com',
    target: '_blank',
    rel: 'nofollow noreferrer',
    children: 'Advertise',
  },
  // {
  //   key: 'careers',
  //   href: '/content/careers',
  //   children: 'Careers',
  // },
  {
    key: '2257',
    href: '/content/2257',
    children: '18 U.S.C. §2257',
    features: (features) => features.isRed,
  },
];

export function AppFooter() {
  const features = useFeatureFlags();
  const domain = useDomainColor();
  const browsingSettingsAddons = useBrowsingSettingsAddons();
  const footerRef = useRef<HTMLElement | null>(null);

  const [showFooter, setShowFooter] = useState(true);
  const scrollRef = useScrollAreaRef({
    onScroll: (node) => {
      setShowFooter(node.scrollTop <= 100);
    },
  });

  const [lastSeenBug] = useLocalStorage<number>({
    key: 'last-seen-bug',
    defaultValue: 0,
    getInitialValueInEffect: false,
  });
  const { data: latestBugUpdate } = trpc.bug.getLatest.useQuery(undefined, {
    enabled: features.bugsPage,
    staleTime: 1000 * 60,
  });
  const showBugDot = !!latestBugUpdate && latestBugUpdate > lastSeenBug;

  return (
    <footer
      ref={footerRef}
      // 🔴 THE PADDING IS NOT HERE, AND THAT IS THE POINT. `<footer>` has no
      // background of its own — the bar below does — so `pb-[…]` on this element
      // buys a TRANSPARENT strip that the page scrolls through, with the home
      // indicator over page content rather than over the bar. It also silently
      // relocates the absolutely-positioned cluster below: `sticky` makes this
      // element the containing block, and an absolute box resolves its offsets
      // against the containing block's PADDING box, so padding here moves the
      // Scroll-to-top and Assistant buttons down by exactly the inset.
      //
      // The bar itself pays instead (see the inner div), and everything that
      // has to agree with the bar's real height reads the SAME expression.
      className="sticky inset-x-0 bottom-0 z-50 mt-3 transition-transform"
      // The hide transform has to travel the bar's REAL height, which is now
      // `--footer-height` plus whatever inset the bar pays. Using
      // `--footer-height` alone leaves the "hidden" footer peeking by up to 34px.
      style={
        !showFooter
          ? {
              transform:
                'translateY(calc(var(--footer-height) + var(--safe-area-inset-bottom-unpaid)))',
            }
          : undefined
      }
    >
      {/* Absolute inside the sticky `<footer>`, so this offset is measured from
          the footer's PADDING box — i.e. from the bottom of the strip the bar
          now pays, not from the bottom of the bar. It has to grow by the same
          inset or the cluster lands inside the bar.

          `right-2` grows too: in landscape on a notched phone the right inset
          is ~47px, so an 8px offset puts the Assistant button's tap target
          inside the cutout strip. Both the base and the `no-scroll` variant
          are offsets from the same edge, so both pay. */}
      <div className="absolute bottom-[calc(var(--footer-height)+var(--safe-area-inset-bottom-unpaid))] right-[calc(0.5rem+var(--safe-area-inset-right))] group-[.no-scroll]:right-[calc(1rem+var(--safe-area-inset-right))]">
        <div className="relative mb-2  flex gap-2 group-[.no-scroll]:mb-3">
          <Button
            px="xs"
            onClick={() => scrollRef?.current?.scrollTo({ top: 0, behavior: 'smooth' })}
            className={'transition-transform'}
            style={showFooter ? { transform: 'translateY(140%)' } : undefined}
            aria-label="Scroll to top"
          >
            <IconArrowUp size={20} stroke={2.5} />
          </Button>
          <AssistantButton />
        </div>
      </div>
      {/* THIS is the box that carries the background, so this is the box that
          pays. Height and padding grow by the SAME term under the global
          `box-sizing: border-box`: padding alone would eat the bar's own 45px,
          squashing the links; growing the height alone would leave a 34px band
          of bar with nothing keeping content out of it. Together they keep the
          content box at 45−4−4=37px and put it exactly where it was, with the
          bar's own background extending down through the home-indicator strip.

          `--safe-area-inset-bottom-unpaid` rather than
          `--safe-area-inset-bottom`: this bar is `sticky bottom-0` inside the
          ScrollArea, so it is the VIEWPORT bottom only when `AdhesiveAd` is not
          rendering below it. See globals.css for why that question is asked of
          the DOM instead of being derived from the user's role. */}
      <div
        className={clsx(
          ' relative flex h-[calc(var(--footer-height)+var(--safe-area-inset-bottom-unpaid))] w-full items-center gap-2 overflow-x-auto bg-gray-0 p-1 px-2 pb-[calc(0.25rem+var(--safe-area-inset-bottom-unpaid))] @sm:gap-3 dark:bg-dark-7',
          {
            ['border-t border-gray-3 dark:border-dark-4']: !features.isRed,
            [`border-red-8 border-t-[3px]`]: features.isRed,
          }
        )}
        style={{ scrollbarWidth: 'thin' }}
      >
        <Text className="select-none text-nowrap font-bold">
          &copy; Civitai {new Date().getFullYear()}
        </Text>
        <div className="flex items-center">
          {footerLinks
            .filter(
              (item) =>
                ((!item.features && !item.domains) ||
                  item.features?.(features) ||
                  item.domains?.includes(domain)) &&
                // !item.defaultExcluded &&
                !(browsingSettingsAddons.settings.excludedFooterLinks ?? []).includes(item.key)
            )
            .map(({ features, key, indicator, ...props }, i) => {
              const showIndicator = indicator && (key === 'issues' ? showBugDot : true);
              let button = (
                <Button
                  key={key ?? i}
                  component={(props.target === '_blank' ? 'a' : Link) as typeof Link}
                  {...props}
                  className={clsx('px-2.5 @max-sm:px-1', {
                    'pr-3.5': showIndicator,
                  })}
                  size="xs"
                  variant="subtle"
                  color="gray"
                />
              );
              if (showIndicator) {
                button = (
                  <Indicator
                    key={key ?? i}
                    position="middle-end"
                    size={6}
                    offset={7}
                    processing
                    color="yellow"
                  >
                    {button}
                  </Indicator>
                );
              }
              return button;
            })}
          <ManageConsentFooterLink />
          <SocialLinks />
        </div>
        <div className="ml-auto flex items-center gap-1">
          <RoutedDialogLink name="support" state={{}} passHref>
            <Button component="a" pl={4} pr="xs" color="yellow" variant="light" size="xs">
              🛟 Support
            </Button>
          </RoutedDialogLink>
        </div>
      </div>
    </footer>
  );
}
