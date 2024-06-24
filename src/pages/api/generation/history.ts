import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import fetch from 'node-fetch';

export default AuthedEndpoint(async function handler(req, res, user) {
  const url = `https://image-generation-scheduler-dev.civitai.com/users/${user.id}/images/download?concurrency=16&startDate=2023-01-01&endDate=2025-01-01`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to get download url: ${response.statusText}`);
  const preSignedUrl = await response.json();
  res.redirect(preSignedUrl);
});
