import { createAdunit } from '~/components/Ads/Playwire/AdUnitFactory';
import classes from './Adunit.module.scss';
import clsx from 'clsx';

export const Adunit_InContent = createAdunit({
  type: 'standard_iab_cntr1',
  className: classes.in_content,
  supportUsSize: '300x250',
});

export const Adunit_InContentSkyscaper = createAdunit({
  type: 'standard_iab_cntr2',
  className: clsx(classes.in_content, classes.in_content_skyscraper),
  supportUsSize: '300x600',
});

export const Adunit_Footer = createAdunit({
  type: 'standard_iab_foot1',
});

// export const Adunit_Head1_Desktop = createAdunit({
//   type: 'standard_iab_head1'
// })
