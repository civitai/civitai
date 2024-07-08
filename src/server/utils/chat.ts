import { uniq } from 'lodash';

export const getChatHash = (userIds: number[]) => {
  return uniq(userIds)
    .sort((a, b) => a - b)
    .join('-');
};
