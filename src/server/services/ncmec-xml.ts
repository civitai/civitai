import type { Report, SubmitFileDetails } from '@civitai/cybertipline-tools';
import { buildReport, buildSubmitFileDetails } from '@civitai/cybertipline-tools';
import { Parser } from 'xml2js';

// Outside the XML 1.0 Char production, lone surrogates included.
const XML_ILLEGAL = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

export const xmlSafe = (text: string) => text.replace(XML_ILLEGAL, '\uFFFD');

/** The CyberTip client writes text into its XML as given, with no entity escaping. */
export const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const xmlText = (text: string) => escapeXml(xmlSafe(text));

/** Why NCMEC would refuse this XML as not well-formed, or null. */
export function xmlProblem(xml: string): string | null {
  if (new RegExp(XML_ILLEGAL.source, 'u').test(xml)) return 'a character XML cannot carry';
  const result = { problem: null as string | null };
  new Parser({ strict: true, async: false }).parseString(xml, (e: Error | null) => {
    if (e) result.problem = e.message.split('\n')[0];
  });
  return result.problem;
}

export const reportXmlProblem = (report: Report) => xmlProblem(buildReport(report));

/** A file's details as known before its upload gives it a fileId. */
export type FileDetailsXml = Omit<SubmitFileDetails, 'reportId' | 'fileId'>;

export const fileDetailsXmlProblem = (details: FileDetailsXml) =>
  xmlProblem(buildSubmitFileDetails({ reportId: 0, fileId: '0', ...details }));

/** Why NCMEC would refuse the report or any of its files' details as not well-formed, or null. */
export const cyberTipXmlProblem = (report: Report, fileDetails: FileDetailsXml[]) =>
  reportXmlProblem(report) ?? fileDetails.map(fileDetailsXmlProblem).find(Boolean) ?? null;
