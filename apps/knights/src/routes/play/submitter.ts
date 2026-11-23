// Chrome < 112 ignores FormData's submitter argument, so a named button's value never reaches the body. Duck-typed so it
// runs in node tests.
export function withSubmitter(formData: FormData, submitter: object | null) {
  const { name, value }: { name?: unknown; value?: unknown } = submitter ?? {};
  if (typeof name !== 'string' || !name || typeof value !== 'string') return;
  if (!formData.has(name)) formData.set(name, value);
}
