import { webUrl } from '../../common/utils/web-url';

/**
 * "Manage your booking", for the emails a guest gets — only when the branch
 * has its booking pages switched on, since that's where the page lives. The
 * link carries the confirmation number only: the guest still types the email
 * the booking is under, so a forwarded or leaked link opens nothing by itself.
 */
export function manageBookingLine(branch: { bookingEngineEnabled: boolean; bookingSlug: string | null }, confirmationNumber: string): string {
  if (!branch.bookingEngineEnabled || !branch.bookingSlug) return '';
  const link = webUrl(`/book/${encodeURIComponent(branch.bookingSlug)}/manage?confirmation=${encodeURIComponent(confirmationNumber)}`);
  return `\n\nManage your booking: ${link}`;
}
