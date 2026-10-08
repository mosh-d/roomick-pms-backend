import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { addBranch, BranchLayout, Client, deleteOrganisation, headBrand, inTenant, lagosDay, Session, signUp, startApp } from './support/e2e';

/**
 * The public booking page and whose profile a booking lands on — third audit, H3 and L17.
 *
 * Every booking path matched an existing guest by email OR the last nine
 * digits of a phone, the public page included. A stranger who typed a
 * guest's email booked onto that guest's profile, "Manage your booking"
 * showed them the guest's phone and nationality, and online check-in
 * rewrote both. A second booking with someone's phone digits and a new email
 * landed on their profile too — and its own booker could no longer find it.
 */
describe('Public booking page (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let client: Client;
  let owner: Session;
  let branch: BranchLayout;
  let other: BranchLayout;
  let slug: string;
  let victimId: string;
  let victimEmail: string;
  const VICTIM_PHONE = '+2348031234567';

  const profile = (id: string) =>
    inTenant(prisma, owner.tenantId, (tx) => tx.guestProfile.findFirst({ where: { id }, select: { name: true, phone: true, nationality: true, marketingOptIn: true } }));
  const bookingGuest = (confirmationNumber: string) =>
    inTenant(prisma, owner.tenantId, (tx) => tx.reservation.findFirst({ where: { confirmationNumber }, select: { guestId: true } })).then((r) => r?.guestId);
  const notesOf = (guestId: string) =>
    inTenant(prisma, owner.tenantId, (tx) => tx.guestNote.findMany({ where: { guestId }, select: { body: true }, orderBy: { createdAt: 'asc' } }));
  const publicBooking = (guestName: string, guestEmail: string, nights: [number, number], guestPhone?: string) =>
    client.post(`/public/properties/${slug}/reservations`, null, {
      roomTypeId: branch.roomTypeId,
      checkInDate: lagosDay(nights[0]),
      checkOutDate: lagosDay(nights[1]),
      adults: 1,
      guestName,
      guestEmail,
      ...(guestPhone ? { guestPhone } : {}),
      acceptTerms: true,
    });

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
    client = new Client(app);
    owner = await signUp(client, 'Public Booking');
    const brandId = await headBrand(client, owner);
    branch = await addBranch(client, owner, brandId, 'Online Branch', 6);
    other = await addBranch(client, owner, brandId, 'Second Branch', 2);
    slug = `e2e-online-${Date.now()}`;
    expect((await client.put(`/branches/${branch.id}/booking-engine`, owner, { slug })).status).toBe(200);

    // Victoria stayed before: the desk has her email and phone.
    victimEmail = `victoria.${Date.now()}@example.com`;
    const staffBooking = await client.post(`/branches/${branch.id}/reservations`, owner, {
      guest: { name: 'Victoria Victim', email: victimEmail, phone: VICTIM_PHONE },
      roomTypeId: branch.roomTypeId,
      checkInDate: lagosDay(20),
      checkOutDate: lagosDay(22),
      adults: 1,
    });
    expect(staffBooking.status).toBe(201);
    victimId = (staffBooking.body.guest?.id ?? staffBooking.body.guestId) as string;
  }, 120_000);

  afterAll(async () => {
    if (owner) expect(await deleteOrganisation(client, prisma, owner)).toBe(true);
    await app?.close();
  });

  it("a stranger who types Victoria's email gets a profile of their own, and sees only what they typed", async () => {
    const before = await profile(victimId);
    const mallory = await publicBooking('Mallory Attacker', victimEmail, [3, 4]);
    expect(mallory.status).toBe(201);
    expect(mallory.body.guestName).toBe('Mallory Attacker');
    expect(await bookingGuest(mallory.body.confirmationNumber as string)).not.toBe(victimId);

    const lookup = await client.post(`/public/properties/${slug}/bookings/lookup`, null, { confirmationNumber: mallory.body.confirmationNumber, email: victimEmail });
    expect(lookup.status).toBe(200);
    expect(lookup.body.guestName).toBe('Mallory Attacker');
    expect(lookup.body).not.toHaveProperty('guestPhone');
    expect(lookup.body).not.toHaveProperty('guestNationality');

    const checkInOnline = await client.post(`/public/properties/${slug}/bookings/pre-arrival`, null, {
      confirmationNumber: mallory.body.confirmationNumber,
      email: victimEmail,
      phone: '+2349990000000',
      nationality: 'xx',
      acceptHouseRules: true,
      marketingOptIn: true,
    });
    expect(checkInOnline.status).toBe(200);
    expect(await profile(victimId)).toEqual(before);
  });

  it("a booking with Victoria's phone but its own email is separate, and its booker can find it", async () => {
    const email = `someone.else.${Date.now()}@example.com`;
    const booking = await publicBooking('Someone Else', email, [5, 6], '08031234567');
    expect(booking.status).toBe(201);
    expect(await bookingGuest(booking.body.confirmationNumber as string)).not.toBe(victimId);
    const lookup = await client.post(`/public/properties/${slug}/bookings/lookup`, null, { confirmationNumber: booking.body.confirmationNumber, email });
    expect(lookup.status).toBe(200);
  });

  it('Victoria booking again herself joins her profile, keeps her phone, and leaves the desk a note', async () => {
    const notesBefore = (await notesOf(victimId)).length;
    // Her name and email as she types them — spacing and case aside — with a new phone.
    const again = await publicBooking('victoria  victim', victimEmail.toUpperCase(), [9, 10], '+2348099999999');
    expect(again.status).toBe(201);
    expect(await bookingGuest(again.body.confirmationNumber as string)).toBe(victimId);
    expect((await profile(victimId))?.phone).toBe(VICTIM_PHONE);
    const notes = await notesOf(victimId);
    expect(notes).toHaveLength(notesBefore + 1);
    expect(notes.at(-1)?.body).toMatch(/\+2348099999999/);

    const lookup = await client.post(`/public/properties/${slug}/bookings/lookup`, null, { confirmationNumber: again.body.confirmationNumber, email: victimEmail });
    expect(lookup.body.guestPhoneEnding).toBe('4567');
    expect(lookup.body).not.toHaveProperty('guestPhone');

    // Online check-in: an empty nationality is filled; a different phone is a note, not an overwrite;
    // and a ticked box never re-subscribes a guest who unsubscribed.
    await inTenant(prisma, owner.tenantId, (tx) => tx.guestProfile.update({ where: { id: victimId }, data: { marketingOptIn: false, marketingUnsubscribedAt: new Date() } }));
    const checkInOnline = await client.post(`/public/properties/${slug}/bookings/pre-arrival`, null, {
      confirmationNumber: again.body.confirmationNumber,
      email: victimEmail,
      phone: '+2347000000000',
      nationality: 'GH',
      acceptHouseRules: true,
      marketingOptIn: true,
    });
    expect(checkInOnline.status).toBe(200);
    expect(await profile(victimId)).toMatchObject({ phone: VICTIM_PHONE, nationality: 'GH', marketingOptIn: false });
    expect((await notesOf(victimId)).at(-1)?.body).toMatch(/\+2347000000000/);
  });

  it('two branches publishing one address at once: one gets it, the other a 409 (was a 500)', async () => {
    const address = `e2e-race-${Date.now()}`;
    const [first, second] = await Promise.all([
      client.put(`/branches/${branch.id}/booking-engine`, owner, { slug: address }),
      client.put(`/branches/${other.id}/booking-engine`, owner, { slug: address }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(await prisma.bookingSlugIndex.count({ where: { slug: address } })).toBe(1);
    // Put the first branch back on its own address for anything after this.
    if (first.status === 200) await client.put(`/branches/${branch.id}/booking-engine`, owner, { slug });
  });
});
