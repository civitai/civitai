/**
 * ClickUp attachments API methods
 *
 * Uses multipart/form-data for file uploads (not JSON).
 * Endpoint: POST /api/v2/task/{task_id}/attachment
 */

import { readFileSync } from 'fs';
import { basename } from 'path';
import { API_BASE, getActiveCredentials } from './client.mjs';

const REQUEST_TIMEOUT_MS = 60000; // 60s for uploads (larger files)
const MAX_RETRIES = 2;

// Guess MIME type from file extension
function guessMimeType(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  const types = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    xml: 'application/xml',
    zip: 'application/zip',
    gz: 'application/gzip',
    tar: 'application/x-tar',
    mp4: 'video/mp4',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
  };
  return types[ext] || 'application/octet-stream';
}

/**
 * Upload a single file attachment to a task.
 *
 * @param {string} taskId - ClickUp task ID
 * @param {string} filePath - Absolute path to the file to upload
 * @returns {Promise<object>} - ClickUp attachment response
 */
export async function uploadAttachment(taskId, filePath) {
  const creds = getActiveCredentials();
  const token = creds.apiToken;
  if (!token) {
    throw new Error('No API token configured. See SKILL.md for setup.');
  }

  const filename = basename(filePath);
  const fileBuffer = readFileSync(filePath);
  const mimeType = guessMimeType(filename);

  // Build multipart/form-data using Node's built-in FormData + Blob
  const formData = new FormData();
  const blob = new Blob([fileBuffer], { type: mimeType });
  formData.append('attachment', blob, filename);

  const url = `${API_BASE}/task/${taskId}/attachment`;

  // Retry logic for rate limiting
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: token,
          // Do NOT set Content-Type — fetch sets it with the multipart boundary
        },
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 429 && attempt < MAX_RETRIES) {
        const resetHeader = response.headers.get('X-RateLimit-Reset');
        let waitMs = 60000;
        if (resetHeader) {
          waitMs = Math.max((parseInt(resetHeader) * 1000) - Date.now(), 1000);
        }
        console.error(`Rate limited. Waiting ${Math.ceil(waitMs / 1000)}s before retry...`);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }

      if (!response.ok) {
        const text = await response.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch {}
        const err = new Error(
          parsed?.err || `ClickUp API error: ${response.status} - ${text}`
        );
        err.status = response.status;
        throw err;
      }

      const text = await response.text();
      if (!text) return {};
      return JSON.parse(text);
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        throw new Error(`Upload timed out after ${REQUEST_TIMEOUT_MS / 1000}s for ${filename}`);
      }
      throw err;
    }
  }
}

/**
 * Upload multiple files to a task.
 *
 * @param {string} taskId - ClickUp task ID
 * @param {string[]} filePaths - Array of absolute file paths
 * @returns {Promise<object[]>} - Array of ClickUp attachment responses
 */
export async function uploadAttachments(taskId, filePaths) {
  const results = [];
  for (const filePath of filePaths) {
    const result = await uploadAttachment(taskId, filePath);
    results.push(result);
  }
  return results;
}
