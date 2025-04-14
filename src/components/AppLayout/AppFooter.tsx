import { Button, Text } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useRef, useState } from 'react';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogProvider';
import { SocialLinks } from '~/components/SocialLinks/SocialLinks';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import clsx from 'clsx';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { IconArrowUp } from '@tabler/icons-react';
import { AssistantButton } from '~/components/Assistant/AssistantButton';
import { ChatPortal } from '~/components/Chat/ChatProvider';
import { FeatureAccess } from '~/server/services/feature-flags.service';

const footerLinks: (React.ComponentProps<typeof Button<typeof Link>> & {
  features?: (features: FeatureAccess) => boolean;
})[] = [
  {
    href: '/creator-program',
    color: 'blue',
    children: 'Creators',
  },
  {
    href: '/content/tos',
    children: 'Terms of Service',
  },
  {
    href: '/content/2257',
    children: '18 U.S.C. 2257',
  },
  {
    href: '/content/privacy',
    children: 'Privacy',
  },
  {
    href: '/safety',
    children: 'Safety',
    features: (features) => features.safety,
  },
  /*   {
    href: '/newsroom',
    children: 'Newsroom',
    features: (features) => features.newsroom,
  }, 
  {
    href: '/github/wiki/REST-API-Reference',
    target: '_blank',
    rel: 'nofollow noreferrer',
    children: 'API',
  },
  */
  {
    href: 'https://status.civitai.com',
    target: '_blank',
    rel: 'nofollow noreferrer',
    children: 'Status',
  },
  /*   {
    href: '/wiki',
    target: '_blank',
    rel: 'nofollow noreferrer',
    children: 'Wiki',
  }, */
  {
    href: '/education',
    target: '_blank',
    rel: 'nofollow noreferrer',
    children: '💡Education',
  },
];

export function AppFooter() {
  const features = useFeatureFlags();
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
      <ChatPortal showFooter={showFooter} />
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
            ['border-t border-gray-3 dark:border-dark-4']: !features.isGreen,
            ['border-green-8 border-t-[3px]']: features.isGreen,
          }
        )}
        style={{ scrollbarWidth: 'thin' }}
      >
        <Text className="select-none text-nowrap font-bold">
          &copy; Civitai {new Date().getFullYear()}
        </Text>
        <div className="flex items-center">
          {footerLinks
            .filter((item) => !item.features || item.features?.(features))
            .map(({ features, ...props }, i) => (
              <Button
                key={i}
                component={Link}
                {...props}
                className="px-2.5 @max-sm:px-1"
                size="xs"
                variant="subtle"
                color="gray"
              />
            ))}

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
