import { DEFAULT_REVIEW_REQUEST, REVIEW_LOOKBACK_DAYS, parseReviewRequestConfig, renderReviewRequest, reviewWindow } from './review-requests';

const BRANCH = '22222222-2222-4222-8222-222222222222';
const valid = { ...DEFAULT_REVIEW_REQUEST, links: { [BRANCH]: 'https://g.page/r/lekki-palms/review' } };

describe('review-requests', () => {
  describe('parseReviewRequestConfig', () => {
    it('accepts the suggested message with a review page', () => {
      expect(parseReviewRequestConfig(valid, [BRANCH]).links[BRANCH]).toBe('https://g.page/r/lekki-palms/review');
    });

    it('needs at least one review page', () => {
      expect(() => parseReviewRequestConfig({ ...valid, links: {} }, [BRANCH])).toThrow(/at least one property/);
    });

    it('takes https links only', () => {
      expect(() => parseReviewRequestConfig({ ...valid, links: { [BRANCH]: 'http://g.page/r/x' } }, [BRANCH])).toThrow(/https/);
      expect(() => parseReviewRequestConfig({ ...valid, links: { [BRANCH]: 'not a url' } }, [BRANCH])).toThrow(/isn’t a web address/);
    });

    it('refuses a link for a property that doesn’t exist', () => {
      expect(() => parseReviewRequestConfig({ ...valid, links: { 'someone-else': 'https://x.example' } }, [BRANCH])).toThrow(/doesn’t exist/);
    });

    it('refuses a message without the review link, or with a placeholder that doesn’t exist', () => {
      expect(() => parseReviewRequestConfig({ ...valid, message: 'Thanks for staying, {{guest_first_name}}!' }, [BRANCH])).toThrow(/\{\{review_url\}\}/);
      expect(() => parseReviewRequestConfig({ ...valid, message: 'Hi {{first_name}} — {{review_url}}' }, [BRANCH])).toThrow(/\{\{first_name\}\}/);
    });

    it('keeps the delay between an hour and a week', () => {
      expect(() => parseReviewRequestConfig({ ...valid, delayHours: 0 }, [BRANCH])).toThrow(/between 1 and 168/);
      expect(() => parseReviewRequestConfig({ ...valid, delayHours: 200 }, [BRANCH])).toThrow(/between 1 and 168/);
      expect(() => parseReviewRequestConfig({ ...valid, delayHours: 2.5 }, [BRANCH])).toThrow(/between 1 and 168/);
    });
  });

  it('fills the first name, the property and the link', () => {
    const { subject, body } = renderReviewRequest(DEFAULT_REVIEW_REQUEST, { guestName: 'Kemi Adeyemi', hotelName: 'Lekki Palms Hotel', reviewUrl: 'https://g.page/r/x' });
    expect(subject).toBe('Thank you for staying at Lekki Palms Hotel');
    expect(body).toContain('Hello Kemi,');
    expect(body).toContain('https://g.page/r/x');
  });

  describe('reviewWindow', () => {
    const now = new Date('2026-09-22T12:00:00Z');

    it('starts when it was switched on, so earlier guests are never asked', () => {
      const enabledAt = new Date('2026-09-21T09:00:00Z');
      expect(reviewWindow(now, enabledAt, 24)).toEqual({ from: enabledAt, to: new Date('2026-09-21T12:00:00Z') });
    });

    it('never reaches back more than a fortnight', () => {
      const { from } = reviewWindow(now, new Date('2025-01-01T00:00:00Z'), 24);
      expect(from).toEqual(new Date(now.getTime() - REVIEW_LOOKBACK_DAYS * 86_400_000));
    });

    it('is empty right after switching on', () => {
      const { from, to } = reviewWindow(now, new Date('2026-09-22T11:00:00Z'), 24);
      expect(from >= to).toBe(true);
    });
  });
});
