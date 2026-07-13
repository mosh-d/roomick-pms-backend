/**
 * Stable, machine-readable error codes (spec §6).
 * Returned in the `code` member of every problem+json response.
 * Add codes here as modules are built — never rename existing ones.
 */
export enum ErrorCode {
  // generic
  VALIDATION_FAILED = 'VALIDATION_FAILED',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  INTERNAL = 'INTERNAL',
  NOT_IMPLEMENTED = 'NOT_IMPLEMENTED',

  // tenancy
  TENANT_HEADER_MISSING = 'TENANT_HEADER_MISSING',
  TENANT_MISMATCH = 'TENANT_MISMATCH',

  // reservations
  RESERVATION_NOT_AVAILABLE = 'RESERVATION_NOT_AVAILABLE',
  OVERBOOKING_NOT_ACKNOWLEDGED = 'OVERBOOKING_NOT_ACKNOWLEDGED',

  // folios & money
  FOLIO_NOT_SETTLED = 'FOLIO_NOT_SETTLED',

  // night audit
  AUDIT_ALREADY_RAN = 'AUDIT_ALREADY_RAN',
}
