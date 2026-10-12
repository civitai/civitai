import { foldConfusables } from '~/server/utils/confusable-fold';

// Usernames are ASCII-only, so the confusables fold alone never sees `clvitai`.
const ASCII_I_LOOKALIKES = /[1l|!]/g;

function matchForms(value: string) {
  const folded = foldConfusables(value);
  const forms = [value.toLowerCase(), folded, folded.replace(ASCII_I_LOOKALIKES, 'i')];
  return [...new Set([...forms, ...forms.map((form) => form.replace(/_/g, ''))])];
}

export function isUsernameBlocked(username: string, lists: { exact: string[]; partial: string[] }) {
  const names = matchForms(username);
  const exact = new Set(lists.exact.flatMap(matchForms));
  const partial = [...new Set(lists.partial.flatMap(matchForms))].filter(Boolean);
  return names.some((name) => exact.has(name) || partial.some((entry) => name.includes(entry)));
}
