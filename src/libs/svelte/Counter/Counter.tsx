import { useRef, useEffect } from 'react';
import SvelteComponent from './Counter.svelte';
import { mount, unmount } from 'svelte';

export function Counter() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = ref.current;
    if (target) {
      const component = mount(SvelteComponent, { target });
      return () => {
        unmount(component);
      };
    }
  }, []);

  return <div ref={ref} />;
}
