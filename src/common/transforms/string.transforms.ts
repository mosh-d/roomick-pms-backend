/** class-transformer helper: lowercase + trim string inputs (emails, subdomains). */
export const toTrimmedLowerCase = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
