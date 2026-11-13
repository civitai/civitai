/** ChoiceGroup's selected and idle tile, shared so every choice control reads the same. */
export const choiceSelectedClass =
  'bg-[var(--mantine-color-blue-light)] text-[var(--mantine-color-blue-light-color)] ring-2 ring-inset ring-[var(--mantine-color-blue-filled)]';
export const choiceIdleClass =
  'bg-[var(--mantine-color-default)] text-[var(--mantine-color-text)] ring-1 ring-inset ring-[var(--mantine-color-default-border)] hover:bg-[var(--mantine-color-default-hover)]';

/** For a Mantine Button used as a choice: pair it with `variant="light"` while selected. */
export const choiceSelectedButtonClass =
  'ring-2 ring-inset ring-[var(--mantine-color-blue-filled)]';
