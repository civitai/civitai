import { NextApiRequest, NextApiResponse } from 'next';
import type { Email } from '~/server/email/templates';
import * as templates from '~/server/email/templates';

export default async function emailPreviewer(req: NextApiRequest, res: NextApiResponse) {
  const { template } = req.query;
  const key = template + 'Email';
  const email = (templates as Record<string, Email>)[key];
  if (!email) return res.status(404).send(`Couldn't find ${key} in ~/server/email/templates`);

  const testInput = req.query;
  const testData = await email.getTestData?.(testInput);
  if (!testData) return res.status(420).send('Missing test data definition');

  const html = email.getHtml(testData);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);

  if (req.query.send) {
    email.send(testData);
    console.log('sent email');
  }
}
