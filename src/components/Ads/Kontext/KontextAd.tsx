import { useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import { useKontextContext } from '~/components/Ads/Kontext/KontextProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useInView } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { TwCard } from '~/components/TwCard/TwCard';
import { isDev } from '~/env/other';
import clsx from 'clsx';
import { Text } from '@mantine/core';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function KontextAd({ index, className }: { index: number; className?: string }) {
  const id = uuidv4();
  const loadedRef = useRef(false);
  const currentUser = useCurrentUser();
  const [ref, inView] = useInView();
  const { kontextReady } = useAdsContext();
  const { getMessages } = useKontextContext();
  const features = useFeatureFlags();

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
        onComplete: (content, metadata) => console.log('complete', { content, metadata }),
        onAdView: () => console.log('ad view'),
      }
    );
  }, [kontextReady, messages?.length, inView]);

  if (!features.kontextAds) return null;

  return (
    <TwCard ref={ref} className={clsx(className)}>
      <Text className="pb-1 text-sm" c="dimmed">
        Sponsored
      </Text>
      <div id={id} />
    </TwCard>
  );
}
