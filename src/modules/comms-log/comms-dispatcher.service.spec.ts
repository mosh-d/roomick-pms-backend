import { Test } from '@nestjs/testing';
import { MAIL_TRANSPORT } from '../../common/mail/mail-transport.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { CommsDispatcherService } from './comms-dispatcher.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function queuedRow(overrides: Record<string, unknown> = {}) {
  return { id: 'log-1', subject: 'Reservation Confirmed', body: 'Your stay is confirmed.', guest: { email: 'guest@example.com' }, ...overrides };
}

describe('CommsDispatcherService', () => {
  let service: CommsDispatcherService;
  let prisma: { withTenant: jest.Mock; tenant: { findMany: jest.Mock } };
  let tx: { communicationLog: { findMany: jest.Mock; update: jest.Mock } };
  let transport: { send: jest.Mock; name: string };

  beforeEach(async () => {
    tx = { communicationLog: { findMany: jest.fn().mockResolvedValue([]), update: jest.fn().mockResolvedValue({}) } };
    prisma = {
      withTenant: jest.fn((_t: string, fn: (x: unknown) => unknown) => fn(tx)),
      tenant: { findMany: jest.fn().mockResolvedValue([{ id: TENANT_ID }]) },
    };
    transport = { send: jest.fn().mockResolvedValue({ externalMessageId: 'prov-1' }), name: 'test' };

    const moduleRef = await Test.createTestingModule({
      providers: [CommsDispatcherService, { provide: PrismaService, useValue: prisma }, { provide: MAIL_TRANSPORT, useValue: transport }],
    }).compile();
    service = moduleRef.get(CommsDispatcherService);
  });

  describe('queue selection', () => {
    it('only picks up queued EMAIL rows — other channels have no transport and must not be touched', async () => {
      await service.dispatchForTenant(TENANT_ID);
      expect(tx.communicationLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { deliveryStatus: 'queued', channel: 'email' } }));
    });

    it('processes the oldest first and caps the batch', async () => {
      await service.dispatchForTenant(TENANT_ID);
      const args = tx.communicationLog.findMany.mock.calls[0][0] as { orderBy: unknown; take: number };
      expect(args.orderBy).toEqual({ sentAt: 'asc' });
      expect(args.take).toBe(50);
    });
  });

  describe('successful send', () => {
    beforeEach(() => tx.communicationLog.findMany.mockResolvedValue([queuedRow()]));

    it('sends the real recipient, subject and body to the transport', async () => {
      await service.dispatchForTenant(TENANT_ID);
      expect(transport.send).toHaveBeenCalledWith({ to: 'guest@example.com', subject: 'Reservation Confirmed', body: 'Your stay is confirmed.' });
    });

    it('marks the row sent and stores the provider message id', async () => {
      const summary = await service.dispatchForTenant(TENANT_ID);
      expect(tx.communicationLog.update).toHaveBeenCalledWith({ where: { id: 'log-1' }, data: { deliveryStatus: 'sent', externalMessageId: 'prov-1' } });
      expect(summary).toEqual({ sent: 1, failed: 0, skipped: 0 });
    });

    it('never marks a row delivered — provider acceptance is not mailbox delivery', async () => {
      await service.dispatchForTenant(TENANT_ID);
      const statuses = tx.communicationLog.update.mock.calls.map((c) => (c[0] as { data: { deliveryStatus: string } }).data.deliveryStatus);
      expect(statuses).not.toContain('delivered');
    });

    it('falls back to a generic subject when the row has none', async () => {
      tx.communicationLog.findMany.mockResolvedValue([queuedRow({ subject: null })]);
      await service.dispatchForTenant(TENANT_ID);
      expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Message from your hotel' }));
    });
  });

  describe('failure handling', () => {
    it('marks a guest with no email address as failed without ever calling the transport', async () => {
      tx.communicationLog.findMany.mockResolvedValue([queuedRow({ guest: { email: null } })]);
      const summary = await service.dispatchForTenant(TENANT_ID);
      expect(transport.send).not.toHaveBeenCalled();
      expect(tx.communicationLog.update).toHaveBeenCalledWith({ where: { id: 'log-1' }, data: { deliveryStatus: 'failed' } });
      expect(summary.failed).toBe(1);
    });

    it('marks a row failed — not back to queued — when the transport throws, so a broken address cannot loop forever', async () => {
      tx.communicationLog.findMany.mockResolvedValue([queuedRow()]);
      transport.send.mockRejectedValue(new Error('smtp refused'));
      const summary = await service.dispatchForTenant(TENANT_ID);
      expect(tx.communicationLog.update).toHaveBeenCalledWith({ where: { id: 'log-1' }, data: { deliveryStatus: 'failed' } });
      expect(summary).toEqual({ sent: 0, failed: 1, skipped: 0 });
    });

    it('one failing row does not stop the rest of the batch', async () => {
      tx.communicationLog.findMany.mockResolvedValue([queuedRow({ id: 'a' }), queuedRow({ id: 'b' }), queuedRow({ id: 'c' })]);
      transport.send.mockRejectedValueOnce(new Error('transient')).mockResolvedValue({ externalMessageId: 'prov-x' });
      const summary = await service.dispatchForTenant(TENANT_ID);
      expect(summary).toEqual({ sent: 2, failed: 1, skipped: 0 });
    });
  });

  describe('cross-tenant sweep', () => {
    it('only sweeps trial and active tenants — suspended/cancelled ones stop sending', async () => {
      await service.dispatchQueued();
      expect(prisma.tenant.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: { in: ['trial', 'active'] } } }));
    });

    it('processes every tenant in its own tenant context', async () => {
      prisma.tenant.findMany.mockResolvedValue([{ id: 'tenant-a' }, { id: 'tenant-b' }]);
      tx.communicationLog.findMany.mockResolvedValue([]);
      await service.dispatchQueued();
      const contexts = prisma.withTenant.mock.calls.map((c) => c[0] as string);
      expect(contexts).toEqual(expect.arrayContaining(['tenant-a', 'tenant-b']));
    });

    it('one tenant blowing up does not stop the others', async () => {
      prisma.tenant.findMany.mockResolvedValue([{ id: 'tenant-a' }, { id: 'tenant-b' }]);
      prisma.withTenant
        .mockImplementationOnce(() => Promise.reject(new Error('tenant-a is broken')))
        .mockImplementation((_t: string, fn: (x: unknown) => unknown) => fn(tx));
      tx.communicationLog.findMany.mockResolvedValue([queuedRow()]);
      const summary = await service.dispatchQueued();
      expect(summary.sent).toBe(1);
    });
  });
});
