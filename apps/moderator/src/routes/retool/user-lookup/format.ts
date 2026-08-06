// Shared formatting for the User Lookup panels. Page-local on purpose — nothing here is general enough
// for $lib, and keeping it beside the panels means changing a format touches one file.

export const LINK_CLASS = 'text-blue-4 hover:underline';

// Every action on this page shares one `form`, so failures carry the panel they belong to — without it
// a refused ban would also render inside the notes panel.
export type FormResult = { scope?: 'notes' | 'account'; error?: string } | null;

export const dateTime = (value: Date | string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '—';

export const num = (value: number) => value.toLocaleString();
