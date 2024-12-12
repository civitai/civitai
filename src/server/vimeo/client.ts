import { OAuth2Client } from 'google-auth-library';
import { google, youtube_v3 } from 'googleapis';
import { Readable } from 'node:stream';
import sanitize from 'sanitize-html';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';
import { fetchBlob } from '~/utils/file-utils';

type S3ToVimeoUpload = {
  url: string;
  title: string;
  description: string;
  mimeType?: string;
  accessToken: string;
  size: number;
};

export const uploadVimeoVideo = async ({
  url,
  accessToken,
  title,
  description,
  size,
}: S3ToVimeoUpload) => {
  const res = await fetch(`https://api.vimeo.com/me/videos`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.vimeo.*+json;version=3.4',
    },
    body: JSON.stringify({
      upload: {
        approach: 'pull',
        link: getEdgeUrl(url, { type: 'video', original: true }),
        size,
      },
      name: title,
      description: sanitize(description, {
        allowedTags: [],
        allowedAttributes: {},
      }),
      // TODO: Add privacy settings. This requires a Plus/Pro account.
      // privacy: {
      //   view: 'unlisted',
      // },
    }),
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }

  return await res.json();
};
