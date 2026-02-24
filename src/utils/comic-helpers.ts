/**
 * Format a date as a relative string (today, yesterday, 3d ago, 2w ago, etc.)
 */
export function formatRelativeDate(date: Date | string): string {
  const now = new Date();
  const d = new Date(date);
  const diff = now.getTime() - d.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return d.toLocaleDateString();
}

/**
 * Convert a PascalCase genre enum value to a human-readable label.
 * e.g. "SliceOfLife" → "Slice Of Life"
 */
export function formatGenreLabel(genre: string): string {
  return genre.replace(/([A-Z])/g, ' $1').trim();
}
