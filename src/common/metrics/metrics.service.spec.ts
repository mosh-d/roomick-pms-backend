import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let service: MetricsService;

  beforeEach(() => {
    service = new MetricsService();
  });

  it('reports null averages/counts of zero when nothing has been recorded yet', () => {
    const snapshot = service.snapshot();
    expect(snapshot.requestCount).toBe(0);
    expect(snapshot.errorCount).toBe(0);
    expect(snapshot.avgResponseTimeMs).toBeNull();
    expect(snapshot.errorRatePct).toBeNull();
  });

  it('counts requests and computes the average response time', () => {
    service.record(100, false);
    service.record(200, false);
    const snapshot = service.snapshot();
    expect(snapshot.requestCount).toBe(2);
    expect(snapshot.errorCount).toBe(0);
    expect(snapshot.avgResponseTimeMs).toBe(150);
    expect(snapshot.errorRatePct).toBe(0);
  });

  it('computes the error rate as a percentage of total requests', () => {
    service.record(50, false);
    service.record(50, true);
    service.record(50, false);
    service.record(50, true);
    const snapshot = service.snapshot();
    expect(snapshot.requestCount).toBe(4);
    expect(snapshot.errorCount).toBe(2);
    expect(snapshot.errorRatePct).toBe(50);
  });

  it('prunes samples older than the 15-minute rolling window', () => {
    const realNow = Date.now;
    let now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      service.record(10, false);
      expect(service.snapshot().requestCount).toBe(1);
      now += 16 * 60_000; // advance past the 15-minute window
      expect(service.snapshot().requestCount).toBe(0);
    } finally {
      Date.now = realNow;
    }
  });
});
