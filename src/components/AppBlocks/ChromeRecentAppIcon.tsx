import { Avatar } from '@mantine/core';
import { IconApps } from '@tabler/icons-react';
import { chromeRecentAppIconSrc } from './chromeRecentAppIconSrc';
import { useChromeListingDetail } from './useChromeListingDetail';

/**
 * A "Recently run" row's icon: the app's own listing icon when the server's listing-media gate
 * lets this viewer see it on this host, otherwise the generic app glyph.
 *
 * 🔴 IT TAKES A SLUG AND NOTHING ELSE. The url comes from the live listing read
 * (`useChromeListingDetail` → `appListings.getAppDetail`), whose `iconUrl` is already gated per
 * image for this request; `chromeRecentAppIconSrc` holds the fail-closed rule. There is no prop
 * a stored url could arrive through.
 *
 * LAZY BY PLACEMENT, like the chrome's other listing reads: this renders inside the platform-nav
 * dropdown / sheet, which Mantine does not mount while closed, so a closed chrome issues no
 * request. Opening it issues at most one read per row (`RECENTLY_RUN_LIMIT`), each deduped by
 * React Query with any other chrome surface reading the same slug.
 */
export function ChromeRecentAppIcon({ slug }: { slug: string }) {
  const src = chromeRecentAppIconSrc(useChromeListingDetail(slug));
  if (!src) return <IconApps size={14} stroke={1.5} data-testid="app-recently-run-icon-generic" />;
  return (
    <Avatar src={src} alt="" size={14} radius="xs" data-testid="app-recently-run-icon-listing" />
  );
}
