import { rulesFacts } from '$lib/server/rules';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ facts: rulesFacts() });
