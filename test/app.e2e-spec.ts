import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { App } from 'supertest/types';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app-setup';

describe('P0 scaffold (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ bodyParser: false });
    // The API exactly as main.ts builds it — body limit, strict validation, error format.
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /api/v1/system/health is public and reports database status', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/system/health').expect(200);
    expect(res.body).toMatchObject({
      status: expect.stringMatching(/^(ok|degraded)$/) as unknown,
      checks: { database: expect.stringMatching(/^(up|down)$/) as unknown },
    });
  });

  it('errors are rendered as application/problem+json with a stable code', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/does-not-exist').expect(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
