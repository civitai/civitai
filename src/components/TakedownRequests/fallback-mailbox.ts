/** Where to write when the form can't take a request: each form's own public mailbox. */
export function fallbackMailbox(processKey: string) {
  if (processKey.startsWith('dmca-')) return 'dmca@civitai.com';
  if (processKey === 'intimate-image-removal' || processKey === 'likeness-claim')
    return 'digital-likeness@civitai.com';
  return 'support@civitai.com';
}
