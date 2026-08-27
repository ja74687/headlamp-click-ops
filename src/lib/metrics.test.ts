import { describe, expect, it } from 'vitest';
import { formatAge, formatBytes, formatCores, parseQuantity, pct, sumNullable } from './metrics';

describe('parseQuantity', () => {
  it('treats a bare number as-is', () => {
    expect(parseQuantity('6')).toBe(6);
  });

  it('handles binary suffixes', () => {
    expect(parseQuantity('1Ki')).toBe(1024);
    expect(parseQuantity('2Mi')).toBe(2 * 1024 * 1024);
    expect(parseQuantity('23Gi')).toBe(23 * 1024 ** 3);
  });

  it('handles SI suffixes, including the sub-unit ones the metrics API uses', () => {
    expect(parseQuantity('1k')).toBe(1000);
    expect(parseQuantity('500m')).toBeCloseTo(0.5);
    expect(parseQuantity('1500000n')).toBeCloseTo(0.0015);
  });

  it('does not confuse the binary Mi with the SI M', () => {
    expect(parseQuantity('1Mi')).not.toBe(parseQuantity('1M'));
  });

  it('returns 0 for empty and unparseable input rather than NaN', () => {
    expect(parseQuantity(undefined)).toBe(0);
    expect(parseQuantity(null)).toBe(0);
    expect(parseQuantity('')).toBe(0);
    expect(parseQuantity('not-a-quantity')).toBe(0);
  });
});

describe('pct', () => {
  it('returns null when either side is unknown', () => {
    expect(pct(null, 100)).toBeNull();
    expect(pct(10, null)).toBeNull();
  });

  it('returns null instead of dividing by zero', () => {
    expect(pct(10, 0)).toBeNull();
  });

  it('clamps to 0..100', () => {
    expect(pct(150, 100)).toBe(100);
    expect(pct(-5, 100)).toBe(0);
  });
});

describe('sumNullable', () => {
  it('is null only when every value is unknown', () => {
    expect(sumNullable([null, null])).toBeNull();
  });

  it('skips unknown values instead of poisoning the sum', () => {
    expect(sumNullable([1, null, 2])).toBe(3);
  });
});

describe('formatting', () => {
  it('renders an em dash for unknown values', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatCores(null)).toBe('—');
  });

  it('scales bytes to a binary unit', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.00 KiB');
    expect(formatBytes(23 * 1024 ** 3)).toBe('23.0 GiB');
  });

  it('renders sub-core CPU in millicores', () => {
    expect(formatCores(0.55)).toBe('550m');
    expect(formatCores(2)).toBe('2.00');
  });

  it('renders ages in the largest sensible unit', () => {
    expect(formatAge(5_000)).toBe('5s');
    expect(formatAge(90_000)).toBe('1m');
    expect(formatAge(3 * 3600_000)).toBe('3h');
    expect(formatAge(5 * 24 * 3600_000)).toBe('5d');
  });
});
