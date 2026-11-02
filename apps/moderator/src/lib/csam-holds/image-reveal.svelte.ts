// Module state: navigations remount the page's components and the choice must outlive them.
//
// It also outlives a reload, per browser, but is never READ at module init: on the server this module is
// shared by every request, and a client that started from storage would hydrate against a server render
// that was blurred. It starts blurred everywhere and `restore()` applies the stored choice after mount.
let revealed = $state(false);
// Once per page load. The page remounts on every client navigation back to it, and re-reading storage
// then would overwrite a choice made since: blocked storage would re-blur it, and a failed write would
// bring back an older reveal the moderator had since turned off.
let restored = false;

export const REVEAL_STORAGE_KEY = 'moderator.csam-holds.reveal-images';

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
    try {
      storage()?.setItem(REVEAL_STORAGE_KEY, revealed ? '1' : '0');
    } catch {
      // Storage blocked or full: the choice lasts until reload.
    }
  },
  /** Apply this browser's stored choice. Only an explicit reveal reveals; anything else stays blurred. */
  restore() {
    if (restored) return;
    restored = true;
    try {
      revealed = storage()?.getItem(REVEAL_STORAGE_KEY) === '1';
    } catch {
      revealed = false;
    }
  },
};
