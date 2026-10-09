/**
 * Room photos uploaded to the app's own storage. The bucket stays private:
 * a photo is served through the API at a public, unguessable address —
 * `/api/v1/public/room-photos/<tenant>/<room type>/<photo>.<ext>` — and that
 * address is what goes into a room type's `photoUrls` beside any pasted links.
 */

/** Largest photo accepted — a phone's full-size JPEG fits; a RAW file doesn't. */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export const ROOM_PHOTO_ROUTE = 'public/room-photos';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PHOTO_FILE = new RegExp(`^${UUID}\\.(jpg|png|webp)$`);
const PHOTO_PATH = new RegExp(`/api/v1/${ROOM_PHOTO_ROUTE}/(${UUID})/(${UUID})/(${UUID}\\.(?:jpg|png|webp))$`);

export const PHOTO_TYPES = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
} as const;
export type PhotoExtension = keyof typeof PHOTO_TYPES;

/** What an image really is, from its first bytes — never the name or type the browser sent. Null: not a JPEG, PNG or WebP. */
export function photoTypeOf(bytes: Buffer): PhotoExtension | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** The storage key of one room photo. */
export function photoKey(tenantId: string, roomTypeId: string, file: string): string {
  return `room-photos/${tenantId}/${roomTypeId}/${file}`;
}

/** Whether a photo file name is one this app gave out — anything else is refused before storage is asked. */
export function isPhotoFile(file: string): boolean {
  return PHOTO_FILE.test(file);
}

/** Where this API is reached from outside — the address a photo is shown at. */
export function publicApiBase(): string {
  return (process.env.PUBLIC_API_BASE_URL || `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/+$/, '');
}

export function photoUrl(tenantId: string, roomTypeId: string, file: string): string {
  return `${publicApiBase()}/api/v1/${ROOM_PHOTO_ROUTE}/${tenantId}/${roomTypeId}/${file}`;
}

/** The storage key behind one of this app's own photo addresses; null for a pasted link. */
export function uploadedPhotoKey(url: string): string | null {
  const match = PHOTO_PATH.exec(url);
  return match ? photoKey(match[1], match[2], match[3]) : null;
}
