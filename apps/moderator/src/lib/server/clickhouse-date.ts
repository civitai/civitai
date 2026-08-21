// ClickHouse returns DateTime as `YYYY-MM-DD HH:MM:SS` in UTC with no zone marker. `new Date()` reads
// that as LOCAL time, so every such value renders shifted by the viewer's offset — putting a Buzz
// transfer on a different calendar day from the IP and prompt events it is meant to line up with.
// Normalise on the server so panels can treat it like any other ISO timestamp.
export const clickhouseDate = (value: string): string =>
  value ? `${value.replace(' ', 'T')}Z` : value;
