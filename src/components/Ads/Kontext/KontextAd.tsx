import { useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useAdsContext } from '~/components/Ads/AdsProvider';
import { useKontextContext } from '~/components/Ads/Kontext/KontextProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useInView } from '~/components/IntersectionObserver/IntersectionObserverProvider';
import { TwCard } from '~/components/TwCard/TwCard';

export function KontextAd({ index }: { index: number }) {
  const id = uuidv4();
  const loadedRef = useRef(false);
  const currentUser = useCurrentUser();
  const [ref, inView] = useInView();
  const { kontextReady } = useAdsContext();
  const { getMessages } = useKontextContext();

  const messages = getMessages(index);

  useEffect(() => {
    console.log({ messages });
    if (loadedRef.current || !ref.current || !kontextReady || !messages?.length || !inView) return;

    loadedRef.current = true;
    window.fetchKontextAd(
      {
        publisherToken: 'civitai-dev',
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
        onComplete: () => console.log('complete'),
        onAdView: () => console.log('ad view'),
      }
    );
  }, [kontextReady, messages?.length, inView]);

  return <TwCard ref={ref} id={id} className="p-2"></TwCard>;
}
