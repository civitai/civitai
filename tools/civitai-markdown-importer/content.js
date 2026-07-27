// Hands raw markdown to the page as a synthetic paste carrying only
// `text/plain`. The article editor's own paste handler recognises markdown
// source and converts it, so this extension ships no markdown parser and cannot
// drift from the conversion rules the site actually applies on save.

const IMPORT_MESSAGE = 'civitai-md-import';

function findEditor() {
  const candidates = Array.from(document.querySelectorAll('.ProseMirror'));
  return candidates.find((node) => node.isContentEditable) || null;
}

function pasteMarkdown(editor, markdown) {
  const before = editor.innerHTML;
  editor.focus();

  const data = new DataTransfer();
  data.setData('text/plain', markdown);

  // dispatchEvent returns false once a listener has called preventDefault(),
  // which is precisely what the page's handler does after it converts.
  const notPrevented = editor.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
  );

  return !notPrevented || editor.innerHTML !== before;
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!message || message.type !== IMPORT_MESSAGE) return false;

  const editor = findEditor();
  if (!editor) {
    respond({ ok: false, reason: 'no-editor' });
    return false;
  }

  if (pasteMarkdown(editor, message.markdown)) {
    respond({ ok: true });
    return false;
  }

  navigator.clipboard.writeText(message.markdown).then(
    () => respond({ ok: false, reason: 'clipboard' }),
    () => respond({ ok: false, reason: 'failed' })
  );

  return true; // keep the channel open for the async respond above
});
