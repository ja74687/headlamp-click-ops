import { describe, expect, it } from 'vitest';
import { formatExpiry, TOKEN_LIFETIMES, wasClamped } from './tokenRequest';

const NOW = Date.parse('2026-01-01T00:00:00Z');

function at(offsetSeconds: number): string {
  return new Date(NOW + offsetSeconds * 1000).toISOString();
}

describe('TOKEN_LIFETIMES', () => {
  it('is ordered shortest first', () => {
    const seconds = TOKEN_LIFETIMES.map(l => l.seconds);
    expect([...seconds].sort((a, b) => a - b)).toEqual(seconds);
  });
});

describe('formatExpiry', () => {
  it('reports hours below two days', () => {
    expect(formatExpiry(at(6 * 3600), NOW)).toBe('6h');
  });

  it('switches to days beyond that', () => {
    expect(formatExpiry(at(30 * 24 * 3600), NOW)).toBe('30d');
  });

  it('says expired for a timestamp in the past', () => {
    expect(formatExpiry(at(-60), NOW)).toBe('expired');
  });

  it('does not throw on a missing or unparseable timestamp', () => {
    expect(formatExpiry('', NOW)).toBe('unknown');
    expect(formatExpiry('not-a-date', NOW)).toBe('unknown');
  });
});

describe('wasClamped', () => {
  const issued = (expiresIn: number, requested: number) => ({
    token: 'x',
    expirationTimestamp: at(expiresIn),
    requestedSeconds: requested,
  });

  it('is false when the server granted what was asked', () => {
    expect(wasClamped(issued(3600, 3600), NOW)).toBe(false);
  });

  it('is true when the server granted noticeably less', () => {
    expect(wasClamped(issued(3600, 90 * 24 * 3600), NOW)).toBe(true);
  });

  it('tolerates round-trip slack rather than crying clamp on a few seconds', () => {
    expect(wasClamped(issued(3600 - 20, 3600), NOW)).toBe(false);
  });

  it('is false when there is no timestamp to compare', () => {
    expect(wasClamped({ token: 'x', expirationTimestamp: '', requestedSeconds: 3600 }, NOW)).toBe(
      false,
    );
  });
});
