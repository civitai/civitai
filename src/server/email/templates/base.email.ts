import { sendEmail } from '~/server/email/client';
export function createEmail<T, T2>(email: {
  header: (data: T) => {
    subject: string;
    from?: string;
    to: string | string[] | null;
    cc?: string | string[] | null;
  };
  html: (data: T) => string;
  text?: (data: T) => string;
  // T must come from the annotated header/html params: TS 7 otherwise infers it from testData's
  // literal return, so send() demands the fixture shape. TS 5.9 resolves it correctly either
  // way, so dropping NoInfer stays green in CI.
  testData?: ((testDataInput: T2) => Promise<NoInfer<T>>) | (() => Promise<NoInfer<T>>);
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
