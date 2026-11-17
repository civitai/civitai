import { getModeratorDb } from '../moderator-db';
import type { CasesTables } from './cases-tables';

/** The moderator database with the case tables typed in; one client, shared with the rest of the app. */
export const casesDb = () => getModeratorDb().withTables<CasesTables>();
export type CasesDb = ReturnType<typeof casesDb>;
