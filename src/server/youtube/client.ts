import { google } from 'googleapis';
import { env } from '~/env/server.mjs';

const OAuth2 = google.auth.OAuth2;

export const getYoutubeAuthUrl = ({
  redirectUri,
  ...state
}: {
  redirectUri: string;
} & MixedObject) => {
  if (!env.YOUTUBE_APP_CLIENT_ID || !env.YOUTUBE_APP_CLIENT_SECRET) {
    throw new Error('Missing YouTube client ID or secret');
  }

  console.log({
    redirectUri: `${env.NEXT_PUBLIC_BASE_URL}${redirectUri}`,
  });

  const oauth2Client = new OAuth2({
    clientId: env.YOUTUBE_APP_CLIENT_ID,
    clientSecret: env.YOUTUBE_APP_CLIENT_SECRET,
    redirectUri: `${env.NEXT_PUBLIC_BASE_URL}${redirectUri}`,
  });

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/youtube.upload'],
    state: JSON.stringify(state),
  });
};
