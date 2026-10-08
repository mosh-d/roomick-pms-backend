/**
 * One CSV cell, safe to open in Excel or Google Sheets.
 *
 * RFC 4180 quoting handles commas, quotes and line breaks. On top of that, a
 * cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is
 * prefixed with an apostrophe: a spreadsheet would otherwise evaluate it as a
 * formula, and guest names, notes and requests are typed by the public on the
 * booking page — `=HYPERLINK("http://evil.example","Open me")` exported as a
 * name was shown live to survive quoting intact. A plain number (`-5.00`) is
 * left alone so negative amounts still add up.
 */
export function csvCell(value: string | number | boolean | Date | null | undefined): string {
  let text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
