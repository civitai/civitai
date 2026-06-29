import type { ReactNode } from 'react';

export const metadata = {
  title: 'Civitai Moderator',
  description: 'Moderator app — monorepo second-app proof of concept',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif' }}>{children}</body>
    </html>
  );
}
