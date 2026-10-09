// `contentVisibility: 'auto'` on each virtual item implies `contain: paint`, which clips every
// descendant to the item's border box no matter what `overflow` says — so a card's
// corner badge gets sliced in half. Padding the item outward by this much (and
// pulling its origin back by the same) gives that overflow somewhere to land while
// leaving the card's own box untouched. Must stay <= half the 16px row/column gap,
// or a later sibling's bleed paints over the badge and undoes the whole thing.
//
// Anything drawn outside a card (corner badges, event decorations) must stay inside this.
export const ITEM_BLEED = 8;
