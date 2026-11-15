import { env } from '$env/dynamic/private';
import { yesNoSettings, type YesNoSettings } from './config';

/** Read per call so a changed environment is picked up without a rebuild. */
export const yesNoConfig = (): YesNoSettings => yesNoSettings(env);
