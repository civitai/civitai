// Module state: navigations remount the page's components and the choice must outlive them.
//
// It also outlives a reload, per moderator in this browser, but is never READ at module init: on the
// server this module is shared by every request, and a client that started from storage would hydrate
// against a server render that was blurred. It starts blurred everywhere and `restore()` applies the
// signed-in moderator's stored choice after mount.
let revealed = $state(false);
// Whose choice is in effect, set by `restore()`. Once per moderator per page load: the page remounts on
// every client navigation back to it, and re-reading storage then would overwrite a choice made since —
// blocked storage would re-blur it, and a failed write would bring back an older reveal.
let moderatorId: number | null = null;

/**
 * Keyed by moderator: workstations are shared, and a choice stored per browser opened the next
 * moderator's holds unblurred without them ever choosing it. The unkeyed entry earlier builds wrote is
 * ignored, never migrated, so everyone starts blurred.
 */
export const revealStorageKey = (id: number) => `moderator.csam-holds.reveal-images:${id}`;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export const imageReveal = {
  get on() {
    return revealed;
  },
  toggle() {
    revealed = !revealed;
    // Before `restore()` nobody is known to store it for; the choice lasts until reload.
    if (moderatorId === null) return;
    try {
      storage()?.setItem(revealStorageKey(moderatorId), revealed ? '1' : '0');
    } catch {
      // Storage blocked or full: the choice lasts until reload.
    }
  },
  /** Apply this moderator's stored choice. Only an explicit reveal reveals; anything else stays blurred. */
  restore(id: number) {
    if (moderatorId === id) return;
    moderatorId = id;
    try {
      revealed = storage()?.getItem(revealStorageKey(id)) === '1';
    } catch {
      revealed = false;
    }
  },
};
