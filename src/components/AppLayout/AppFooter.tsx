import { Button, Indicator, Text } from '@mantine/core';
import { IconArrowUp } from '@tabler/icons-react';
import clsx from 'clsx';
import { useRef, useState } from 'react';
import { AssistantButton } from '~/components/Assistant/AssistantButton';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { SocialLinks } from '~/components/SocialLinks/SocialLinks';
import { useDomainColor } from '~/hooks/useDomainColor';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ColorDomain } from '~/shared/constants/domain.constants';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

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
  {
    key: 'newsroom',
    href: '/newsroom',
    children: 'Newsroom',
    features: (features) => features.newsroom,
  },
  {
    key: 'api',
    href: '/github/wiki/REST-API-Reference',
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
    key: 'education',
    href: '/education',
    target: '_blank',
    rel: 'nofollow noreferrer',
    children: '💡 Education',
  },
  {
    key: 'creator-program',
    href: '/creator-program',
    color: 'blue',
    children: 'Creators',
  },
  {
    key: 'careers',
    href: '/content/careers',
    children: 'Careers',
  },
  {
    key: '2257',
    href: '/content/2257',
    children: '18 U.S.C. §2257',
    features: (features) => !features.isGreen,
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

  return (
    <footer
      ref={footerRef}
      className="sticky inset-x-0 bottom-0 z-50 mt-3 transition-transform"
      style={!showFooter ? { transform: 'translateY(var(--footer-height))' } : undefined}
    >
      <div className="absolute bottom-[var(--footer-height)] right-2 group-[.no-scroll]:right-4">
        <div className="relative mb-2  flex gap-2 group-[.no-scroll]:mb-3">
          <Button
            px="xs"
            onClick={() => scrollRef?.current?.scrollTo({ top: 0, behavior: 'smooth' })}
            className={'transition-transform'}
            style={showFooter ? { transform: 'translateY(140%)' } : undefined}
          >
            <IconArrowUp size={20} stroke={2.5} />
          </Button>
          <AssistantButton />
        </div>
      </div>
      <div
        className={clsx(
          ' relative flex h-[var(--footer-height)] w-full items-center gap-2  overflow-x-auto bg-gray-0 p-1 px-2 @sm:gap-3 dark:bg-dark-7',
          {
            ['border-t border-gray-3 dark:border-dark-4']: domain === 'blue',
            [`border-red-8 border-t-[3px]`]: domain === 'red',
            [`border-green-8 border-t-[3px]`]: domain === 'green',
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
              let button = (
                <Button
                  key={key ?? i}
                  component={Link}
                  {...props}
                  className={clsx('px-2.5 @max-sm:px-1', {
                    'pr-3.5': indicator,
                  })}
                  size="xs"
                  variant="subtle"
                  color="gray"
                />
              );
              if (indicator) {
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
