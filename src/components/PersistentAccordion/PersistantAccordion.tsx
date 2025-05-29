import type { AccordionProps } from '@mantine/core';
import { Accordion } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';

export function PersistentAccordion({
  storeKey,
  defaultValue,
  ...props
}: AccordionProps & { storeKey: string; defaultValue?: string }) {
  const [value, setValue] = useLocalStorage({ key: storeKey, defaultValue: defaultValue ?? null });

  return <Accordion value={value} onChange={setValue} {...props} />;
}
