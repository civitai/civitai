import { Router } from 'next/router';

// next/link prefetches every hovered route in production. In the Pages Router,
// `prefetch={false}` only disables the *viewport* prefetch, not hover/touch, and
// there is no official global opt-out — so we neuter the router's prefetch method.
// Patching the prototype (not an instance) runs before any <Link> mounts, so it
// can't race the viewport IntersectionObserver.
//
// NOTE: this disables ALL prefetch app-wide — `<Link prefetch>` becomes a no-op.
// Prefetch is already a no-op in dev, so this only changes production behavior.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Router.prototype as any).prefetch = function () {
  return Promise.resolve();
};
