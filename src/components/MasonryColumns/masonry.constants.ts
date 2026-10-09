// `contentVisibility: 'auto'` on each virtual item implies `contain: paint`, which clips every
// descendant to the item's border box no matter what `overflow` says — so a card's
// corner badge gets sliced in half. Padding the item outward by this much (and
// pulling its origin back by the same) gives that overflow somewhere to land while
// leaving the card's own box untouched.
//
// It is wider than the 16px gap between cards (a worn event hat reaches up to ~31px past its
// card), so each item's padding lies over its neighbours' cards: the item must not take pointer
// events itself, only the card inside it.
//
// Anything drawn outside a card (corner badges, event decorations) must stay inside this.
export const ITEM_BLEED = 32;
