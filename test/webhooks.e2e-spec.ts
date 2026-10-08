import { INestApplication } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { createServer, IncomingHttpHeaders, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { App } from 'supertest/types';
import { EncryptionService } from '../src/common/crypto/encryption.service';
import { IntegrationsService } from '../src/modules/integrations/integrations.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { Client, deleteOrganisation, inTenant, Session, signUp, startApp } from './support/e2e';

/**
 * Webhook signing secrets — third audit, M9.
 *
 * The secret that signs every delivery was stored as generated, though the
 * code said otherwise: a copy of the database was enough to forge deliveries
 * a customer's server would trust. It is stored encrypted now, the
 * dispatcher decrypts it to sign, and secrets saved before are encrypted by
 * a pass shortly after the API starts.
 */
describe('Webhook secrets (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let client: Client;
  let owner: Session;
  let receiver: Server;
  let received: Array<{ headers: IncomingHttpHeaders; body: string }>;
  let url: string;

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
    client = new Client(app);
    owner = await signUp(client, 'Webhooks');
    received = [];
    receiver = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
  }, 120_000);

  afterAll(async () => {
    await new Promise((resolve) => receiver?.close(resolve));
    if (owner) expect(await deleteOrganisation(client, prisma, owner)).toBe(true);
    await app?.close();
  });

  it('stores the secret encrypted, and a test delivery is signed with the secret the customer was shown', async () => {
    const events = (await client.get('/webhooks/events', owner)).body as Array<{ type: string }>;
    const hook = await client.post('/webhooks', owner, { url, eventTypes: [events[0].type] });
    expect(hook.status).toBe(201);
    const shown = hook.body.secret as string;

    const stored = await inTenant(prisma, owner.tenantId, (tx) => tx.webhook.findFirstOrThrow({ where: { id: hook.body.id as string }, select: { secret: true } }));
    expect(stored.secret).not.toBe(shown);
    expect(stored.secret).toContain(':');
    expect(app.get(EncryptionService).decrypt(stored.secret)).toBe(shown);

    const test = await client.post(`/webhooks/${hook.body.id}/test`, owner);
    expect(test.status).toBe(200);
    expect(received).toHaveLength(1);
    const signature = String(received[0].headers['roomick-signature']);
    const [, timestamp, digest] = /t=(\d+),v1=([0-9a-f]+)/.exec(signature) ?? [];
    expect(digest).toBe(createHmac('sha256', shown).update(`${timestamp}.${received[0].body}`).digest('hex'));
  });

  it('encrypts a secret stored in plain text before this change, in place', async () => {
    const plain = 'ab'.repeat(24);
    const row = await inTenant(prisma, owner.tenantId, (tx) =>
      tx.webhook.create({ data: { tenantId: owner.tenantId, url, eventTypes: ['reservation.created'], secret: plain, createdBy: owner.userId }, select: { id: true } }),
    );
    expect(await app.get(IntegrationsService).encryptPlainWebhookSecrets()).toBeGreaterThanOrEqual(1);
    const after = await inTenant(prisma, owner.tenantId, (tx) => tx.webhook.findFirstOrThrow({ where: { id: row.id }, select: { secret: true } }));
    expect(after.secret).not.toBe(plain);
    expect(app.get(EncryptionService).decrypt(after.secret)).toBe(plain);
  });
});
