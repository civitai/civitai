export function getEvictableAction(evictable: boolean) {
  return evictable
    ? {
        label: 'Mark not evictable',
        message:
          "Generation nodes will be told not to evict the last copy of this version's files.",
        next: false,
      }
    : {
        label: 'Mark evictable',
        message:
          "Generation nodes may evict the last copy of this version's files when they need space.",
        next: true,
      };
}
