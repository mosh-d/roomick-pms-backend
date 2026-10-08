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
  TOO_MANY_REQUESTS = 'TOO_MANY_REQUESTS',

  // tenancy
  TENANT_HEADER_MISSING = 'TENANT_HEADER_MISSING',
  TENANT_MISMATCH = 'TENANT_MISMATCH',

  // auth & identity
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED',
  TOKEN_INVALID = 'TOKEN_INVALID',
  SUBDOMAIN_TAKEN = 'SUBDOMAIN_TAKEN',
  EMAIL_TAKEN = 'EMAIL_TAKEN',
  INVITE_INVALID = 'INVITE_INVALID',
  /** Password accepted; a second step (authenticator code) is required before a session is issued. */
  MFA_REQUIRED = 'MFA_REQUIRED',
  MFA_INVALID_CODE = 'MFA_INVALID_CODE',
  /** Too many wrong codes in a row — two-step sign-in is paused for this account for a short while. */
  MFA_LOCKED = 'MFA_LOCKED',
  BRAND_MODE_ALREADY_CONFIGURED = 'BRAND_MODE_ALREADY_CONFIGURED',

  // property
  BRAND_LIMIT_SINGLE_MODE = 'BRAND_LIMIT_SINGLE_MODE',
  INVALID_TIMEZONE = 'INVALID_TIMEZONE',
  BRANCH_NAME_TAKEN = 'BRANCH_NAME_TAKEN',
  ROOM_NUMBERS_TAKEN = 'ROOM_NUMBERS_TAKEN',
  INVALID_STATUS_TRANSITION = 'INVALID_STATUS_TRANSITION',

  // reservations
  RESERVATION_NOT_AVAILABLE = 'RESERVATION_NOT_AVAILABLE',
  OVERBOOKING_NOT_ACKNOWLEDGED = 'OVERBOOKING_NOT_ACKNOWLEDGED',
  CANCELLATION_TERMS_CHANGED = 'CANCELLATION_TERMS_CHANGED',

  // folios & money
  FOLIO_NOT_SETTLED = 'FOLIO_NOT_SETTLED',

  // night audit
  AUDIT_ALREADY_RAN = 'AUDIT_ALREADY_RAN',

  // shifts
  SHIFT_ALREADY_OPEN = 'SHIFT_ALREADY_OPEN',
  SHIFT_ALREADY_CLOSED = 'SHIFT_ALREADY_CLOSED',
  /** Cash was offered with no shift open to put it in. */
  SHIFT_REQUIRED = 'SHIFT_REQUIRED',
  /** Checking in before the booked arrival day — the stay's dates are moved first. */
  EARLY_CHECK_IN = 'EARLY_CHECK_IN',
  /** The organisation is suspended or cancelled — nobody in it may sign in or keep working. */
  TENANT_SUSPENDED = 'TENANT_SUSPENDED',
  /** The request body is over the size the API accepts (a photo too large, usually). */
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',
  /** The guest is owed money on this bill — it can't be closed until the credit is refunded or moved. */
  FOLIO_CREDIT_BALANCE = 'FOLIO_CREDIT_BALANCE',
}
