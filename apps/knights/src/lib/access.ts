export type Access = 'allow' | 'closed';

export function decideAccess({
  isModerator,
  flagOn,
}: {
  isModerator: boolean | undefined;
  flagOn: boolean;
}): Access {
  return isModerator === true || flagOn ? 'allow' : 'closed';
}
