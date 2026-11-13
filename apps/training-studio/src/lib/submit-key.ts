/** A fresh batch submit key (see `TrainingRunInput.submitKey`). Hex, 32 chars. */
export function newSubmitKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
