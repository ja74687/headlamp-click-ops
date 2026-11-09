/**
 * htpasswd lines in the Apache MD5 format (`$apr1$`), computed in the browser.
 *
 * The ingress-nginx compatibility mode in Traefik reads basic-auth users from a Secret holding
 * an htpasswd file, and `$apr1$` is the format `openssl passwd -apr1` produces and that was
 * checked against a live cluster (401 without or with a wrong password, 200 with the right
 * one). Web Crypto has no MD5, hence the small implementation here; the tests pin it to
 * openssl's output.
 *
 * MD5-crypt is not a strong hash — 1000 rounds of MD5 — and the Secret should be treated as
 * sensitive. It is what nginx-style basic auth has always used.
 */

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// Per-round shift amounts and the sine-derived constants of RFC 1321.
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const K = Array.from(
  { length: 64 },
  (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0
);

/** MD5 digest of a byte array (RFC 1321). */
export function md5(input: Uint8Array): Uint8Array {
  const bitLength = input.length * 8;
  const paddedLength = (((input.length + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(paddedLength);
  buf.set(input);
  buf[input.length] = 0x80;
  const view = new DataView(buf.buffer);
  // Length in bits, little-endian, low 32 bits then high 32 bits.
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const m = (j: number) => view.getUint32(offset + j * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + K[i] + m(g)) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << S[i]) | (sum >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => outView.setUint32(i * 4, v, true));
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function to64(value: number, count: number): string {
  let out = '';
  let v = value;
  for (let i = 0; i < count; i++) {
    out += ITOA64[v & 0x3f];
    v >>>= 6;
  }
  return out;
}

/** A random 8-character salt from the crypt alphabet. */
export function randomSalt(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => ITOA64[b & 0x3f]).join('');
}

/**
 * `$apr1$<salt>$<hash>` for a password, the MD5-crypt variant Apache's htpasswd and
 * `openssl passwd -apr1` produce. Only the first 8 salt characters count.
 */
export function apr1(password: string, salt: string = randomSalt()): string {
  const enc = new TextEncoder();
  const magic = '$apr1$';
  const s = salt.slice(0, 8);
  const pw = enc.encode(password);
  const saltBytes = enc.encode(s);

  let alternate = md5(concat(pw, saltBytes, pw));
  const parts: Uint8Array[] = [pw, enc.encode(magic), saltBytes];
  for (let left = pw.length; left > 0; left -= 16) {
    parts.push(alternate.subarray(0, Math.min(left, 16)));
  }
  for (let i = pw.length; i > 0; i >>= 1) {
    parts.push(i & 1 ? new Uint8Array([0]) : pw.subarray(0, 1));
  }
  let final = md5(concat(...parts));

  // 1000 rounds, which is all that "slow" means for MD5-crypt.
  for (let i = 0; i < 1000; i++) {
    const round: Uint8Array[] = [i & 1 ? pw : final];
    if (i % 3) round.push(saltBytes);
    if (i % 7) round.push(pw);
    round.push(i & 1 ? final : pw);
    final = md5(concat(...round));
  }
  alternate = final;

  const f = alternate;
  const hash =
    to64((f[0] << 16) | (f[6] << 8) | f[12], 4) +
    to64((f[1] << 16) | (f[7] << 8) | f[13], 4) +
    to64((f[2] << 16) | (f[8] << 8) | f[14], 4) +
    to64((f[3] << 16) | (f[9] << 8) | f[15], 4) +
    to64((f[4] << 16) | (f[10] << 8) | f[5], 4) +
    to64(f[11], 2);
  return `${magic}${s}$${hash}`;
}

/** One htpasswd line. The username must not contain ":" — validate before calling. */
export function htpasswdLine(username: string, password: string, salt?: string): string {
  return `${username}:${apr1(password, salt)}`;
}
