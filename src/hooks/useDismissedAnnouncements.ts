import { uniq } from 'lodash-es';
import { useCallback, useEffect, useState } from 'react';
import useIsClient from '~/hooks/useIsClient';

const useDismissedAnnouncements = (announcementIds: number[] = []) => {
  const isClient = useIsClient();
  const [dismissed, setDismissed] = useState(announcementIds);

  useEffect(() => {
    const getDismissedAnnouncements = () => {
      const dismissedIds = Object.keys(localStorage)
        .filter((key) => key.startsWith('announcement-'))
        .map((key) => Number(key.replace('announcement-', '')));

      if (dismissedIds.length === 0 && localStorage.getItem('welcomeAlert') === 'false')
        dismissedIds.push(0);

      return uniq(dismissedIds);
    };

    if (isClient) {
      setDismissed(getDismissedAnnouncements());
    }
    // Fetch get all dismissed announcements
  }, [announcementIds, isClient]);

  const onAnnouncementDismiss = useCallback(
    (announcementId: number) => {
      localStorage.setItem(`announcement-${announcementId}`, 'true');
      setDismissed(uniq([...dismissed, announcementId]));
    },
    [dismissed]
  );

  return {
    dismissed,
    onAnnouncementDismiss,
  };
};

export { useDismissedAnnouncements };
