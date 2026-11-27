/**
 * A ref callback that scrolls its node into view when the page was opened on `hash`. For anchor
 * targets that render only once their data loads, after the browser's own hash scroll has fired.
 * Create it at module level so the ref identity stays stable.
 */
export function scrollIfHashed(hash: string) {
  return (node: HTMLElement | null) => {
    if (node && typeof window !== 'undefined' && window.location.hash === hash) {
      node.scrollIntoView({ block: 'start' });
    }
  };
}
