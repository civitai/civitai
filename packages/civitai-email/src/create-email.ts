// Generic template factory — identical API to the app's templates/base.email.ts so existing
// `createEmail({...})` templates work unchanged. Templates themselves (branded copy) stay in
// each app; this just standardizes how they bind to the transport.
import { sendEmail } from './client';

export function createEmail<T, T2>(email: {
  header: (data: T) => { subject: string; from?: string; to: string | string[] | null };
  html: (data: T) => string;
  text?: (data: T) => string;
  testData?: ((testDataInput: T2) => Promise<T>) | (() => Promise<T>);
}) {
  const send = async (data: T) => {
    await sendEmail({
      ...email.header(data),
      html: email.html(data),
      text: email.text?.(data),
    });
  };

  const getHtml = (data: T) => email.html(data);

  return {
    send,
    getHtml,
    getTestData: email.testData,
  };
}

export type Email = ReturnType<typeof createEmail>;
