import { describe, expect, it } from 'vitest';
import { apr1, htpasswdLine, md5, randomSalt } from './htpasswd';

const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
const utf8 = (s: string) => new TextEncoder().encode(s);

describe('md5', () => {
  // Expected values from `printf ... | openssl md5`.
  it.each([
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['Zażółć', 'f1607cd9abc293d131af748f41dc9556'],
    ['The quick brown fox jumps over the lazy dog', '9e107d9d372bb6826bd81d3542a419d6'],
  ])('hashes "%s"', (input, expected) => {
    expect(hex(md5(utf8(input)))).toBe(expected);
  });

  it('handles input that spills into a second block', () => {
    // 56..63 bytes force the length into a second 64-byte block.
    expect(hex(md5(utf8('a'.repeat(56))))).toBe('3b0c8ac703f828b04c6c197006d17218');
    expect(hex(md5(utf8('a'.repeat(64))))).toBe('014842d480b571495a4a0363793f7367');
  });
});

describe('apr1', () => {
  // Expected values from `printf '<password>' | openssl passwd -apr1 -salt <salt> -stdin`
  // (OpenSSL 3.5.5). Through stdin, not as an argument: on Windows an argument reaches
  // openssl in the ANSI code page, so a non-ASCII password would be hashed as CP1250, not UTF-8.
  it.each([
    ['password', 'abcdefgh', '$apr1$abcdefgh$FBwExRW4dCc8aL.OvjpIE1'],
    ['test-haslo', 'saltsalt', '$apr1$saltsalt$vvkf4mfZlXZJ89HYbjxMT1'],
    ['Zażółć gęślą jaźń', 'x7Gq./Zz', '$apr1$x7Gq./Zz$vu7kbKWzy9vdMWGHqKMOH0'],
    ['a', '12345678', '$apr1$12345678$68ZQVfPkWX/wcXr/41VxQ.'],
    [
      'a-much-longer-password-that-exceeds-sixteen-bytes',
      'Ab.9/zZ0',
      '$apr1$Ab.9/zZ0$N0Kr8LQh3gaakBoSinpWJ1',
    ],
  ])('matches openssl for "%s"', (password, salt, expected) => {
    expect(apr1(password, salt)).toBe(expected);
  });

  it('uses only the first 8 salt characters', () => {
    expect(apr1('password', 'abcdefghXYZ')).toBe(apr1('password', 'abcdefgh'));
  });

  it('salts each hash differently by default', () => {
    expect(apr1('same')).not.toBe(apr1('same'));
    expect(randomSalt()).toMatch(/^[./0-9A-Za-z]{8}$/);
  });
});

describe('htpasswdLine', () => {
  it('builds user:hash', () => {
    expect(htpasswdLine('admin', 'password', 'abcdefgh')).toBe(
      'admin:$apr1$abcdefgh$FBwExRW4dCc8aL.OvjpIE1'
    );
  });
});
