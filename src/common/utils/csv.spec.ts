import { csvCell } from './csv';

describe('csvCell', () => {
  it('leaves plain text and numbers alone', () => {
    expect(csvCell('Ada Obi')).toBe('Ada Obi');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes a cell with a comma, a quote or a line break (RFC 4180)', () => {
    expect(csvCell('Obi, Ada')).toBe('"Obi, Ada"');
    expect(csvCell('the "Grand" suite')).toBe('"the ""Grand"" suite"');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('keeps a spreadsheet from evaluating a guest-typed name as a formula', () => {
    expect(csvCell('=HYPERLINK("http://evil.example/x","Open me")')).toBe('"\'=HYPERLINK(""http://evil.example/x"",""Open me"")"');
    expect(csvCell('+2348012345678')).toBe("'+2348012345678");
    expect(csvCell('@everyone')).toBe("'@everyone");
    expect(csvCell('-cmd')).toBe("'-cmd");
  });

  it('leaves a negative amount as a number — a refund still adds up', () => {
    expect(csvCell('-5.00')).toBe('-5.00');
    expect(csvCell(-5)).toBe('-5');
  });
});
