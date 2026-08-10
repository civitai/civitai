// Every action on this page shares one `form`, so failures carry the panel they belong to — without it
// a refused ban would also render inside the notes panel.
export type FormResult = {
  scope?:
    | 'notes'
    | 'account'
    /** The Enable Edits form on Basic. Distinct from `account`, whose only renderer is the panel
     *  on Admin — scoping identity there discarded its refusals on the section they happen on. */
    | 'identity'
    | 'socials'
    | 'profile'
    | 'content'
    | 'buzz'
    | 'shop'
    | 'notify';
  error?: string;
} | null;
