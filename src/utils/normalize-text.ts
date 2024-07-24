import he from 'he';

export function normalizeText(input?: string): string {
  if (!input) return '';
  return he
    .decode(input)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}
