import { createAdunit } from '~/components/Ads/Playwire/AdUnitFactory';
import classes from './Adunit.module.scss';
import clsx from 'clsx';

export const Adunit_InContent = createAdunit({
  type: 'in_content',
  className: classes.in_content,
  supportUsSize: '300x250',
});

export const Adunit_InContentSkyscaper = createAdunit({
  type: 'in_content_skyscraper',
  className: clsx(classes.in_content, classes.in_content_skyscraper),
  supportUsSize: '300x600',
});
