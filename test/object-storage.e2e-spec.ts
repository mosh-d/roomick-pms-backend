import { INestApplication } from '@nestjs/common';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { addBranch, book, BranchLayout, Client, deleteOrganisation, headBrand, lagosDay, Session, signUp, startApp } from './support/e2e';

/**
 * A stand-in S3-compatible store: path-style PUT, GET and DELETE of
 * /<bucket>/<key>, as Cloudflare R2 and MinIO take them. Signatures aren't
 * checked — it's what the app sends and reads back that's under test.
 */
function fakeS3(): { server: Server; objects: Map<string, { body: Buffer; type: string }> } {
  const objects = new Map<string, { body: Buffer; type: string }>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const key = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/[^/]+\//, '');
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'PUT') {
        objects.set(key, { body: Buffer.concat(chunks), type: String(req.headers['content-type'] ?? 'application/octet-stream') });
        res.writeHead(200, { ETag: '"etag"' }).end();
      } else if (req.method === 'GET') {
        const object = objects.get(key);
        if (!object) {
          res.writeHead(404, { 'Content-Type': 'application/xml' }).end('<?xml version="1.0" encoding="UTF-8"?><Error><Code>NoSuchKey</Code><Message>No such key</Message></Error>');
          return;
        }
        res.writeHead(200, { 'Content-Type': object.type, 'Content-Length': object.body.length }).end(object.body);
      } else if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204).end();
      } else res.writeHead(405).end();
    });
  });
  return { server, objects };
}

/** The smallest real PNG: one transparent pixel. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');

describe('Object storage — room photos and documents (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let client: Client;
  let owner: Session;
  let branch: BranchLayout;
  const s3 = fakeS3();
  const saved: Record<string, string | undefined> = {};
  const env = (name: string, value: string) => {
    saved[name] = process.env[name];
    process.env[name] = value;
  };

  beforeAll(async () => {
    await new Promise<void>((resolve) => s3.server.listen(0, '127.0.0.1', resolve));
    env('STORAGE_S3_ENDPOINT', `http://127.0.0.1:${(s3.server.address() as AddressInfo).port}`);
    env('STORAGE_S3_REGION', 'auto');
    env('STORAGE_S3_BUCKET', 'roomick-test');
    env('STORAGE_S3_ACCESS_KEY_ID', 'test-key');
    env('STORAGE_S3_SECRET_ACCESS_KEY', 'test-secret');
    ({ app, prisma } = await startApp());
    client = new Client(app);
    owner = await signUp(client, 'Object Storage');
    branch = await addBranch(client, owner, await headBrand(client, owner), 'Photo Branch', 2);
  }, 120_000);

  afterAll(async () => {
    if (owner) expect(await deleteOrganisation(client, prisma, owner)).toBe(true);
    await app?.close();
    await new Promise<void>((resolve) => s3.server.close(() => resolve()));
    // Every suite after this one runs without a bucket, as before.
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  const upload = (body: Buffer, name: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/room-types/${branch.roomTypeId}/photos`)
      .set({ Authorization: `Bearer ${owner.token}`, 'X-Tenant-ID': owner.tenantId })
      .attach('photo', body, name);

  it('uploads a room photo to the bucket and shows it at a public address', async () => {
    expect((await client.get(`/branches/${branch.id}/room-photo-uploads`, owner)).body).toEqual({ enabled: true, maxBytes: 5 * 1024 * 1024 });

    const uploaded = await upload(PNG, 'room.png');
    expect(uploaded.status).toBe(201);
    const url = (uploaded.body as { photoUrls: string[] }).photoUrls.at(-1)!;
    expect(url).toMatch(/\/api\/v1\/public\/room-photos\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/);
    expect([...s3.objects.keys()].some((key) => key.startsWith(`room-photos/${owner.tenantId}/${branch.roomTypeId}/`))).toBe(true);

    // Anyone can see it — no sign-in — from another origin, cached for good.
    const shown = await request(app.getHttpServer()).get(new URL(url).pathname);
    expect(shown.status).toBe(200);
    expect(shown.headers['content-type']).toBe('image/png');
    expect(shown.headers['cache-control']).toContain('immutable');
    expect(shown.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(Buffer.from(shown.body as Buffer).equals(PNG)).toBe(true);

    // Not an image, whatever it's called: refused, nothing stored.
    const before = s3.objects.size;
    expect((await upload(Buffer.from('<svg onload="alert(1)"/>'), 'evil.png')).status).toBe(400);
    expect(s3.objects.size).toBe(before);
    expect((await request(app.getHttpServer()).get(`/api/v1/public/room-photos/${owner.tenantId}/${branch.roomTypeId}/..%2F..%2Fdocuments`)).status).toBe(404);

    // Taken off the room type: gone from the bucket too.
    expect((await client.patch(`/room-types/${branch.roomTypeId}`, owner, { photoUrls: [] })).status).toBe(200);
    expect([...s3.objects.keys()].some((key) => key.startsWith('room-photos/'))).toBe(false);
  });

  it('keeps an ID document photo in the bucket, encrypted', async () => {
    const stay = await book(client, owner, branch, 'Document Guest', lagosDay(0), lagosDay(1));
    const checkedIn = await client.post(`/reservations/${stay}/check-in`, owner, {
      roomId: branch.rooms[0].id,
      idDocument: { idDocType: 'passport', idDocNumber: 'A1234567', photoBase64: PNG.toString('base64') },
    });
    expect(checkedIn.status).toBe(201);
    const stored = [...s3.objects.entries()].find(([key]) => key.startsWith(`documents/${owner.tenantId}/id-documents/`));
    expect(stored).toBeDefined();
    // Encrypted before it left the app: not the photo's own bytes.
    expect(stored![1].body.includes(PNG.subarray(0, 8))).toBe(false);
  });
});
