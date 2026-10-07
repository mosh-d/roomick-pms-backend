import { envValidationSchema } from './env.validation';

const BASE = {
  DATABASE_URL: 'postgresql://roomick:roomick@localhost:5432/roomick',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  ENCRYPTION_KEY: 'c'.repeat(64),
};

const validate = (env: Record<string, string>) => envValidationSchema.validate({ ...BASE, ...env }, { abortEarly: true });

describe('envValidationSchema — email settings', () => {
  it('starts without any email settings — nothing is sent, messages go to the log', () => {
    expect(validate({}).error).toBeUndefined();
    expect(validate({ SMTP_HOST: '', MAIL_FROM: '' }).error).toBeUndefined();
  });

  it('needs a sender once an SMTP server is set', () => {
    expect(validate({ SMTP_HOST: 'smtp.resend.com' }).error?.message).toMatch(/MAIL_FROM/);
  });

  it('takes a bare address or a name with the address in angle brackets', () => {
    expect(validate({ SMTP_HOST: 'smtp.resend.com', MAIL_FROM: 'bookings@lekki.example' }).error).toBeUndefined();
    expect(validate({ SMTP_HOST: 'smtp.resend.com', MAIL_FROM: 'Lekki Suites <bookings@lekki.example>' }).error).toBeUndefined();
    expect(validate({ SMTP_HOST: 'smtp.resend.com', MAIL_FROM: 'Lekki Suites' }).error?.message).toMatch(/MAIL_FROM must be an address/);
  });

  it('refuses a port that cannot be one', () => {
    expect(validate({ SMTP_HOST: 'smtp.resend.com', MAIL_FROM: 'a@b.example', SMTP_PORT: '70000' }).error?.message).toMatch(/SMTP_PORT/);
  });
});
