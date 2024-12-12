import sanitize from 'sanitize-html';
import { getEdgeUrl } from '~/client-utils/cf-images-utils';

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
      privacy: {
        view: 'unlisted',
      },
    }),
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }

  return await res.json();
};

export const checkVideoAvailable = async ({
  id,
  accessToken,
}: {
  id: string;
  accessToken: string;
}) => {
  const res = await fetch(
    `https://api.vimeo.com/videos/${id}?fields=link,upload.status,transcode.status`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.vimeo.*+json;version=3.4',
        contentType: 'application/json',
      },
    }
  );

  if (!res.ok) {
    return null;
  }

  const data: { link: string; upload: { status: string }; transcode: { status: string } } =
    await res.json();

  if (data.upload?.status !== 'complete' || data.transcode?.status !== 'complete') {
    return null;
  }

  return data.link;
};
