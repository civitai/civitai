// Module state, not component state: filter and paging navigations remount the page's components,
// and the choice must outlive them. It is never stored, so a reload blurs again.
let revealed = $state(false);

export const imageReveal = {
  get on() {
    return revealed;
  },
  toggle() {
    revealed = !revealed;
  },
};
