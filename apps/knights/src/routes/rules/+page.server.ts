import { db } from '$lib/server/db';
import { rulesFacts } from '$lib/server/rules';
import { judgesNeeded } from '$lib/server/yesno/items';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({ facts: rulesFacts(await judgesNeeded(db)) });
