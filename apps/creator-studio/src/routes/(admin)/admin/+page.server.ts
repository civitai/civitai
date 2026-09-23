import type { PageServerLoad } from './$types';
import { readAnalyticsPeriod } from '$lib/server/analytics-period';
import {
  getMonetizationAdoption,
  getMonetizationMoney,
} from '$lib/server/admin/monetization-overview';

export const load: PageServerLoad = async ({ cookies }) => {
  const { range } = readAnalyticsPeriod(cookies);
  const [adoption, money] = await Promise.all([
    getMonetizationAdoption({}).catch(() => null),
    getMonetizationMoney(range).catch(() => null),
  ]);
  return { adoption, money, range };
};
