import { createAdunit, createAdunitLUT } from '~/components/Ads/Playwire/AdUnitFactory';
import classes from './Adunit.module.scss';
import clsx from 'clsx';

export const Adunit_InContent = createAdunit({
  type: 'standard_iab_cntr1',
  className: clsx(classes.center, classes.in_content),
  supportUsSize: '300x250',
});

export const Adunit_InContentSkyscaper = createAdunit({
  type: 'standard_iab_cntr2',
  className: clsx(classes.center, classes.in_content, classes.in_content_skyscraper),
  supportUsSize: '300x600',
});

export const Adunit_Footer = createAdunit({
  type: 'standard_iab_foot1',
  className: classes.center,
});

export const Adunit_FooterImageDetail = createAdunit({
  type: 'standard_iab_foot1',
  className: clsx(classes.center, classes.footer),
  supportUsSize: '970x90',
});

export const Adunit_Modal = createAdunit({
  type: 'standard_iab_modl1',
  className: clsx(classes.center, classes.in_content),
  supportUsSize: '300x250',
});

const AdunitBannerMobile = createAdunit({
  type: 'standard_iab_head2',
  className: clsx(classes.center, classes.banner_mobile),
  supportUsSize: '300x100',
});
const AdunitBannerDesktopTall = createAdunit({
  type: 'standard_iab_head2',
  className: clsx(classes.center, classes.banner_desktop_tall),
  supportUsSize: '970x250',
});
const AdunitBannerDesktopShort = createAdunit({
  type: 'standard_iab_head1',
  className: clsx(classes.center, classes.banner_desktop_short),
  supportUsSize: '728x90',
});

export const AdunitBanner = createAdunitLUT([
  {
    component: AdunitBannerMobile,
  },
  {
    minWidth: 970,
    component: AdunitBannerDesktopTall,
  },
]);

export const AdunitBannerPostDetail = createAdunitLUT([
  {
    component: AdunitBannerMobile,
  },
  {
    minWidth: 970,
    component: AdunitBannerDesktopShort,
  },
]);

// export const Adunit_Head1_Desktop = createAdunit({
//   type: 'standard_iab_head1'
// })
