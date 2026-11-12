import { NavBannerStrip } from '~/components/AppLayout/NavAnnouncementSlot/NavAnnouncementSlot';
import { useNavBannersDismissed } from '~/components/AppLayout/NavAnnouncementSlot/nav-banners-dismissed';
import type { NavBanner } from '~/shared/constants/nav-banner.constants';

export const KNIGHTS_V2_ARTICLE_URL = '/articles/38647';

const banner: NavBanner = {
  id: 'knights-v2-switchover',
  title: 'Knights v2 arrives',
  accent: 'Tuesday 11/17.',
  text: 'At knights.civitai.com. Your rank comes with you, and gold moves to a new shop.',
  href: KNIGHTS_V2_ARTICLE_URL,
  cta: "See what's changing",
  image: '820ede9b-b96f-4d72-9983-8415f3dc044e',
  // The cover art's left edge, so the strip runs on seamlessly into the image.
  background: '#2b1542',
  dismissible: true,
  priority: 0,
};

export function NewOrderSwitchoverBanner() {
  const { dismissed, dismiss } = useNavBannersDismissed();

  if (dismissed.includes(banner.id)) return null;

  return <NavBannerStrip banner={banner} onDismiss={() => dismiss(banner.id)} />;
}
