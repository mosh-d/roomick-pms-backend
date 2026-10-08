import { ChargeType, PaymentMethod, ReservationChannel, ReservationStatus } from '@prisma/client';

/**
 * Custom Report Builder's catalogue: the datasets a report can be built
 * from and the columns each offers. A report can only ever name these —
 * every run is checked against them, so a saved template or a hand-made
 * request can't reach a column or table that isn't listed here.
 */
export type FieldType = 'text' | 'enum' | 'number' | 'money' | 'date';

export interface CatalogField {
  key: string;
  label: string;
  type: FieldType;
  /** `enum` fields: the values, for the filter picker. */
  options?: string[];
}

export type DatasetKey = 'reservations' | 'charges' | 'payments' | 'guests';

export interface Dataset {
  key: DatasetKey;
  label: string;
  /** What the report's dates are matched against. */
  dateLabel: string;
  fields: CatalogField[];
}

export const OPERATORS: Record<FieldType, Array<{ key: string; label: string }>> = {
  text: [
    { key: 'contains', label: 'contains' },
    { key: 'equals', label: 'is' },
    { key: 'not_equals', label: 'is not' },
  ],
  enum: [
    { key: 'equals', label: 'is' },
    { key: 'not_equals', label: 'is not' },
  ],
  number: [
    { key: 'eq', label: '=' },
    { key: 'ne', label: '≠' },
    { key: 'gt', label: '>' },
    { key: 'gte', label: '≥' },
    { key: 'lt', label: '<' },
    { key: 'lte', label: '≤' },
  ],
  money: [
    { key: 'eq', label: '=' },
    { key: 'ne', label: '≠' },
    { key: 'gt', label: '>' },
    { key: 'gte', label: '≥' },
    { key: 'lt', label: '<' },
    { key: 'lte', label: '≤' },
  ],
  date: [
    { key: 'on', label: 'on' },
    { key: 'before', label: 'before' },
    { key: 'after', label: 'after' },
  ],
};

// The schema's own enums, so the pickers can't drift from what's stored.
const RESERVATION_STATUSES: string[] = Object.values(ReservationStatus);
const CHANNELS: string[] = Object.values(ReservationChannel);
const CHARGE_TYPES: string[] = Object.values(ChargeType);
const METHODS: string[] = Object.values(PaymentMethod);

export const DATASETS: Dataset[] = [
  {
    key: 'reservations',
    label: 'Reservations',
    dateLabel: 'Arriving between',
    fields: [
      { key: 'confirmationNumber', label: 'Confirmation #', type: 'text' },
      { key: 'status', label: 'Status', type: 'enum', options: RESERVATION_STATUSES },
      { key: 'channel', label: 'Channel', type: 'enum', options: CHANNELS },
      { key: 'guestName', label: 'Guest', type: 'text' },
      { key: 'guestEmail', label: 'Guest email', type: 'text' },
      { key: 'guestPhone', label: 'Guest phone', type: 'text' },
      { key: 'roomType', label: 'Room type', type: 'text' },
      { key: 'room', label: 'Room', type: 'text' },
      { key: 'company', label: 'Company', type: 'text' },
      { key: 'group', label: 'Group', type: 'text' },
      { key: 'checkInDate', label: 'Check-in', type: 'date' },
      { key: 'checkOutDate', label: 'Check-out', type: 'date' },
      { key: 'nights', label: 'Nights', type: 'number' },
      { key: 'adults', label: 'Adults', type: 'number' },
      { key: 'children', label: 'Children', type: 'number' },
      { key: 'roomTotal', label: 'Room total', type: 'money' },
      { key: 'bookedOn', label: 'Booked on', type: 'date' },
    ],
  },
  {
    key: 'charges',
    label: 'Charges',
    dateLabel: 'Service date between',
    fields: [
      { key: 'serviceDate', label: 'Service date', type: 'date' },
      { key: 'department', label: 'Department', type: 'enum', options: CHARGE_TYPES },
      { key: 'description', label: 'Description', type: 'text' },
      { key: 'amount', label: 'Amount', type: 'money' },
      { key: 'guestName', label: 'Guest', type: 'text' },
      { key: 'room', label: 'Room', type: 'text' },
      { key: 'confirmationNumber', label: 'Confirmation #', type: 'text' },
      { key: 'outlet', label: 'Outlet', type: 'text' },
      { key: 'postedBy', label: 'Posted by', type: 'text' },
    ],
  },
  {
    key: 'payments',
    label: 'Payments & refunds',
    dateLabel: 'Taken between',
    fields: [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'method', label: 'Method', type: 'enum', options: METHODS },
      { key: 'kind', label: 'Payment or refund', type: 'enum', options: ['payment', 'refund'] },
      { key: 'amount', label: 'Amount', type: 'money' },
      { key: 'reference', label: 'Reference', type: 'text' },
      { key: 'guestName', label: 'Guest', type: 'text' },
      { key: 'confirmationNumber', label: 'Confirmation #', type: 'text' },
      { key: 'recordedBy', label: 'Taken by', type: 'text' },
    ],
  },
  {
    key: 'guests',
    label: 'Guests who booked here',
    dateLabel: 'First seen between',
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'email', label: 'Email', type: 'text' },
      { key: 'phone', label: 'Phone', type: 'text' },
      { key: 'nationality', label: 'Nationality', type: 'text' },
      { key: 'vipLevel', label: 'VIP level', type: 'number' },
      { key: 'loyaltyTier', label: 'Loyalty tier', type: 'text' },
      { key: 'loyaltyPoints', label: 'Loyalty points', type: 'number' },
      { key: 'firstSeen', label: 'First seen', type: 'date' },
    ],
  },
];

export function datasetOf(key: string): Dataset | undefined {
  return DATASETS.find((d) => d.key === key);
}
