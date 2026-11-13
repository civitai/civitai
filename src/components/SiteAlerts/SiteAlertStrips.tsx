import { keepPreviousData } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import { useNavBannersDismissed } from '~/components/AppLayout/NavAnnouncementSlot/nav-banners-dismissed';
import { useSiteAlertsVersionStore } from '~/components/SiteAlerts/site-alerts-version.store';
import { useDomainColor } from '~/hooks/useDomainColor';
import { useMaybeAppContext } from '~/providers/AppProvider';
import { SiteAlertStrip } from '~/components/SiteAlerts/SiteAlertStrip';
import type { SiteAlert } from '~/shared/constants/site-alert.constants';
import { visibleSiteAlerts } from '~/shared/utils/site-alert-match';
import { hashify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

/** Keyed on the copy too, so an edited alert shows again to people who dismissed it. */
export function siteAlertDismissKey(alert: Pick<SiteAlert, 'id' | 'title' | 'message'>) {
  return `site-alert:${alert.id}:${hashify(`${alert.title}\n${alert.message ?? ''}`)}`;
}

const CATCH_UP_ATTEMPTS = 5;

/**
 * A pod that could not re-read yet answers with an older version; ask again a few times. Bounded:
 * if the version itself went backwards (the CLIENT hash replaced by hand), every answer is older,
 * and the next save or a reload is what catches the tab up.
 */
export function catchUpInterval(
  state: { data?: { version: number }; dataUpdateCount: number; errorUpdateCount: number },
  v: number
) {
  const behind = (state.data?.version ?? v) < v;
  const attempts = state.dataUpdateCount + state.errorUpdateCount;
  return behind && attempts < CATCH_UP_ATTEMPTS ? 3_000 : false;
}

export function useSiteAlerts() {
  const seed = useMaybeAppContext()?.siteAlerts;
  const noted = useSiteAlertsVersionStore((s) => s.version);
  const v = Math.max(noted, seed?.version ?? 0);
  const { data } = trpc.siteAlerts.getActive.useQuery(
    { v },
    {
      initialData: seed && seed.version === v ? seed : undefined,
      placeholderData: keepPreviousData,
      refetchInterval: (query) => catchUpInterval(query.state, v),
    }
  );
  return data?.alerts ?? [];
}

export function SiteAlertStrips() {
  const alerts = useSiteAlerts();
  const { asPath } = useRouter();
  const domain = useDomainColor();
  const { dismissed, dismiss, restore } = useNavBannersDismissed();

  const visible = visibleSiteAlerts(alerts, { pathname: asPath, domain, now: Date.now() }).filter(
    (x) => !(x.dismissible && dismissed.includes(siteAlertDismissKey(x)))
  );

  return (
    <>
      {visible.map((alert) => (
        <SiteAlertStrip
          key={alert.id}
          alert={alert}
          onDismiss={() => {
            // The cookie is shared with event banners and capped, so drop keys for alerts that
            // are gone or were edited rather than letting them push event dismissals out.
            const current = new Set(alerts.map(siteAlertDismissKey));
            restore(...dismissed.filter((x) => x.startsWith('site-alert:') && !current.has(x)));
            dismiss(siteAlertDismissKey(alert));
          }}
        />
      ))}
    </>
  );
}
