const IMPORT_MESSAGE = 'civitai-md-import';

const REASONS = {
  'no-editor': 'No article editor on this tab. Open the Create or Edit article page.',
  clipboard:
    'Could not paste automatically, so the markdown is on your clipboard — click into the editor and press Cmd/Ctrl+V.',
  failed: 'Could not paste, and writing to the clipboard was blocked.',
};

const fileInput = document.getElementById('file');
const statusEl = document.getElementById('status');

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind || '';
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = ''; // allow re-picking the same file after an edit
  if (!file) return;

  setStatus(`Reading ${file.name}…`);

  let markdown;
  try {
    markdown = await file.text();
  } catch {
    setStatus('Could not read that file.', 'err');
    return;
  }

  if (!markdown.trim()) {
    setStatus('That file is empty.', 'err');
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    setStatus('No active tab.', 'err');
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: IMPORT_MESSAGE, markdown }, (response) => {
    if (chrome.runtime.lastError || !response) {
      setStatus('Open a Civitai article Create or Edit page, then try again.', 'err');
      return;
    }
    if (response.ok) setStatus(`Imported ${file.name}.`, 'ok');
    else setStatus(REASONS[response.reason] || 'Import failed.', 'err');
  });
});
