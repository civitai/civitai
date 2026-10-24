import { BlocklistType } from '~/server/common/enums';
import { getBlocklistData } from '~/server/services/blocklist.service';
import { isUsernameBlocked } from '~/server/utils/username-blocklist';
import blockedUsernames from '~/utils/blocklist-username.json';

export const isUsernamePermitted = async (username: string): Promise<boolean> => {
  if (isUsernameBlocked(username, blockedUsernames)) return false;

  const [exact, partial] = await Promise.all([
    getBlocklistData(BlocklistType.UsernameExact),
    getBlocklistData(BlocklistType.UsernamePartial),
  ]);
  return !isUsernameBlocked(username, { exact, partial });
};
