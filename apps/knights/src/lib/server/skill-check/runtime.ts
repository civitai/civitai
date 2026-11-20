import { env } from '$env/dynamic/private';
import { storedSettings } from '../settings/runtime';
import { skillCheckSettings, type SkillCheckSettings } from './config';

/** Read per call so a changed environment is picked up without a rebuild; the moderators' saved values are read at most every 30s. */
export const skillChecks = async (): Promise<SkillCheckSettings> =>
  skillCheckSettings(env, await storedSettings());
