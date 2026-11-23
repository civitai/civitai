// SvelteKit's enhance builds the body with `new FormData(form, submitter)`, and Chrome < 112 ignores the second
// argument, so the pressed button's name/value (the vote's `answer`) never reaches the server. Duck-typed rather than
// `instanceof HTMLButtonElement` so it runs in node tests.
export function withSubmitter(formData: FormData, submitter: object | null) {
  if (!submitter || !('name' in submitter) || !('value' in submitter)) return;
  const { name, value } = submitter;
  if (typeof name !== 'string' || !name || typeof value !== 'string') return;
  if (!formData.has(name)) formData.set(name, value);
}
