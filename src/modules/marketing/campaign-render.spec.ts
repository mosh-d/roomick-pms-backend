import {
  escapeHtml,
  hasUnsubscribeField,
  renderForRecipient,
  renderMergeFields,
  signTarget,
  trackingUrlsFor,
  unknownMergeFields,
  variantFor,
  verifyTarget,
} from './campaign-render';

const SECRET = 'test-secret';
const TOKEN = 'a'.repeat(48);
const CONTEXT = {
  guest_name: 'Kemi Adeyemi',
  guest_first_name: 'Kemi',
  hotel_name: 'Lekki Palms Hotel',
  loyalty_tier: 'Silver',
  loyalty_points: '550',
};

describe('campaign-render', () => {
  describe('merge fields', () => {
    it('names every placeholder that would not resolve', () => {
      expect(unknownMergeFields('Hi {{first_name}}, {{guest_name}} — {{ points }}')).toEqual(['first_name', 'points']);
      expect(unknownMergeFields('Hi {{ guest_first_name }}')).toEqual([]);
    });

    it('substitutes known placeholders and leaves unknown ones visible', () => {
      expect(renderMergeFields('Hi {{guest_first_name}} ({{loyalty_tier}}) {{nope}}', { ...CONTEXT, unsubscribe_url: 'u' })).toBe('Hi Kemi (Silver) {{nope}}');
    });

    it('knows whether the author placed the unsubscribe link themselves', () => {
      expect(hasUnsubscribeField('Leave: {{ unsubscribe_url }}')).toBe(true);
      expect(hasUnsubscribeField('No link here')).toBe(false);
    });
  });

  describe('click signing', () => {
    it('verifies its own signature and nothing else', () => {
      const sig = signTarget(TOKEN, 'https://hotel.example/offer', SECRET);
      expect(verifyTarget(TOKEN, 'https://hotel.example/offer', sig, SECRET)).toBe(true);
      // An edited destination — the open-redirect attempt.
      expect(verifyTarget(TOKEN, 'https://evil.example/', sig, SECRET)).toBe(false);
      // A signature lifted from another guest's email.
      expect(verifyTarget('b'.repeat(48), 'https://hotel.example/offer', sig, SECRET)).toBe(false);
      expect(verifyTarget(TOKEN, 'https://hotel.example/offer', 'short', SECRET)).toBe(false);
    });
  });

  describe('renderForRecipient', () => {
    const tracking = trackingUrlsFor('https://api.example.com/', TOKEN, SECRET);

    it('builds absolute tracking URLs under the API prefix', () => {
      expect(tracking.pixelUrl).toBe(`https://api.example.com/api/v1/public/marketing/open/${TOKEN}.gif`);
      expect(tracking.unsubscribeUrl).toBe(`https://api.example.com/api/v1/public/marketing/unsubscribe/${TOKEN}`);
    });

    it('rewrites every link through the signed click redirect, keeping sentence punctuation outside it', () => {
      const { text } = renderForRecipient('Book at https://hotel.example/offer?x=1. See you!', CONTEXT, tracking);
      const expected = tracking.clickUrlFor('https://hotel.example/offer?x=1');
      expect(text).toContain(`Book at ${expected}. See you!`);
      expect(text).not.toContain('Book at https://hotel.example/offer?x=1.');
    });

    it('never routes the unsubscribe link through the click tracker', () => {
      const { text, html } = renderForRecipient('Hello {{guest_first_name}}.\n\nLeave any time: {{unsubscribe_url}}', CONTEXT, tracking);
      expect(text).toContain(`Leave any time: ${tracking.unsubscribeUrl}`);
      expect(text).not.toContain('/click/');
      expect(html).not.toMatch(/click\/[a-f0-9]+\?u=[^"]*unsubscribe/);
      // The author placed it, so no second footer is added.
      expect(text.match(/unsubscribe\//g)).toHaveLength(1);
    });

    it('leaves the word "unsubscribe" in the copy alone', () => {
      const { text } = renderForRecipient('If you want to unsubscribe from these, use this: {{unsubscribe_url}}', CONTEXT, tracking);
      expect(text).toBe(`If you want to unsubscribe from these, use this: ${tracking.unsubscribeUrl}`);
    });

    it('adds an unsubscribe footer when the author left the link out', () => {
      const { text, html } = renderForRecipient('Hello {{guest_name}}', CONTEXT, tracking);
      expect(text).toContain(`To stop: ${tracking.unsubscribeUrl}`);
      expect(html).toContain('Unsubscribe</a>');
      expect(html).toContain(tracking.unsubscribeUrl);
    });

    it('puts the open pixel in the HTML part only', () => {
      const { text, html } = renderForRecipient('Hello', CONTEXT, tracking);
      expect(html).toContain(`<img src="${tracking.pixelUrl}" width="1" height="1"`);
      expect(text).not.toContain('.gif');
    });

    it('escapes guest-supplied text in the HTML part', () => {
      const { html } = renderForRecipient('Hello {{guest_name}}', { ...CONTEXT, guest_name: '<script>x</script>' }, tracking);
      expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
      expect(html).not.toContain('<script>');
    });

    it('turns blank lines into paragraphs and single newlines into breaks', () => {
      const { html } = renderForRecipient('One\ntwo\n\nThree', CONTEXT, tracking);
      expect(html).toContain('One<br />two</p>');
      expect(html).toContain('>Three</p>');
    });
  });

  describe('variantFor', () => {
    it('splits exactly, not by coin toss', () => {
      const variants = Array.from({ length: 10 }, (_, i) => variantFor(i, 10, 0.5));
      expect(variants.filter((v) => v === 'A')).toHaveLength(5);
      expect(variants.filter((v) => v === 'B')).toHaveLength(5);
      expect(Array.from({ length: 10 }, (_, i) => variantFor(i, 10, 0.3)).filter((v) => v === 'A')).toHaveLength(3);
    });

    it('keeps at least one guest on each side when there are two or more', () => {
      expect([variantFor(0, 2, 0.05), variantFor(1, 2, 0.05)]).toEqual(['A', 'B']);
      expect([variantFor(0, 2, 0.95), variantFor(1, 2, 0.95)]).toEqual(['A', 'B']);
    });

    it('sends everyone variant A when there is no test', () => {
      expect(variantFor(7, 10, null)).toBe('A');
    });
  });

  it('escapes all five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
