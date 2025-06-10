import { uniq } from 'lodash-es';

export const getChatHash = (userIds: number[]) => {
  return uniq(userIds)
    .sort((a, b) => a - b)
    .join('-');
};

export const getUsersFromHash = (hash: string) => {
  return hash.split('-').map((id) => parseInt(id, 10));
};
