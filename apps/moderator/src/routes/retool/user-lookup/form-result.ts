// Every action on this page shares one `form`, so failures carry the panel they belong to — without it
// a refused ban would also render inside the notes panel.
export type FormResult =
  | { scope?: 'notes' | 'account' | 'socials' | 'profile' | 'content'; error?: string }
  | null;
