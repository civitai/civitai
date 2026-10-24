// Module state: navigations remount the page's components and the choice must outlive them.
let revealed = $state(false);

export const imageReveal = {
  get on() {
    return revealed;
  },
  toggle() {
    revealed = !revealed;
  },
};
