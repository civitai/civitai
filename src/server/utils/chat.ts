import { uniq } from 'lodash-es';

export const getChatHash = (userIds: number[]) => {
  return uniq(userIds)
    .sort((a, b) => a - b)
    .join('-');
};
