import { vi } from 'vitest';

// Compiling the real barrel adds about a minute to any suite that renders a component importing it, and
// nothing fails to say so. Every name resolves to a component that renders nothing.
vi.mock('@tabler/icons-svelte', () => {
  const Icon = () => undefined;
  return new Proxy({}, { get: (_, name) => (name === 'then' ? undefined : Icon), has: () => true });
});
