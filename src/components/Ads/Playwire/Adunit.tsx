import { createAdunit } from '~/components/Ads/Playwire/AdUnitFactory';
import classes from './Adunit.module.scss';

export const Adunit_InContent = createAdunit({ type: 'in_content', className: classes.in_content });
