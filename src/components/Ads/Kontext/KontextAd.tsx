import { useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import { useKontextContext } from '~/components/Ads/Kontext/KontextProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useInView } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { TwCard } from '~/components/TwCard/TwCard';
import { isDev } from '~/env/other';
import { Text } from '@mantine/core';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { lipsum } from '~/server/common/constants';

function KontextAdContent({ index, className }: { index: number; className?: string }) {
  const id = uuidv4();
  const loadedRef = useRef(false);
  const currentUser = useCurrentUser();
  const [ref, inView] = useInView();
  const { kontextReady } = useAdsContext();
  const { getMessages } = useKontextContext();

  const messages = getMessages(index);

  useEffect(() => {
    if (loadedRef.current || !ref.current || !kontextReady || !messages?.length || !inView) return;

    loadedRef.current = true;
    window.fetchKontextAd(
      {
        publisherToken: isDev ? 'civitai-dev' : 'civitai-b9c3s0xx6u',
        code: 'inlineAd',
        userId: currentUser?.emailHash ?? uuidv4(),
        conversationId: 'conversation',
        messages: messages.map(({ content, createdAt }) => ({
          id: uuidv4(),
          role: 'user',
          createdAt: createdAt ?? new Date(),
          content,
        })),
        element: ref.current,
      },
      {
        onStart: () => console.log('start'),
        onError: (e) => console.log('error', e),
        onComplete: (content, metadata) => {
          console.log('complete', { content, metadata });
          if (isDev && !content.length && ref.current) {
            ref.current.innerHTML = `<div class="kontext-ad-container"><em class="kontext-em">whispers</em> You know, that cat's got some serious skills. Maybe you should check out <a class="kontext-a" href="https://server.megabrain.co/impression/0197c1c3-253c-7dd3-a8f6-f6e60aa8842d/redirect" target="_blank">MasterClass: Small Habits that Make a Big Impact on Your Life</a>. James Clear's got some tricks to help you stick to your goals, just like that cat sticking to its fish! </div>`;
          }
        },
        onAdView: () => console.log('ad view'),
        onBid: async (value) => {
          return !!value;
        },
      }
    );
  }, [kontextReady, messages?.length, inView]);

  return (
    <TwCard className={className}>
      <Text className="pb-1 text-sm" c="dimmed">
        Sponsored
      </Text>
      <div
        ref={ref}
        id={id}
        className="flex min-h-24 flex-col justify-center @sm:min-h-20 @md:min-h-12 @lg:min-h-6"
      ></div>
    </TwCard>
  );
}

export function KontextAd(props: { index: number; className?: string }) {
  const features = useFeatureFlags();
  const { kontextAvailable } = useAdsContext();

  if (!features.kontextAds || !kontextAvailable) return null;
  return <KontextAdContent {...props} />;
}
