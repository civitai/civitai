// Every action on this page shares one , so failures carry the panel they belong to — without it
// a refused ban would also render inside the notes panel.
export type FormResult = { scope?: 'notes' | 'account'; error?: string } | null;
