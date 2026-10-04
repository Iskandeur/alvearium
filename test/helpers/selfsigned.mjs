// A self-signed certificate made in Node, no openssl: what an intercepting proxy (the claude.ai/code
// agent proxy terminates TLS to add the credential) presents to the session. Test use only.
import { X509Certificate, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

const len = (n) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const oid = (s) => {
  const n = s.split('.').map(Number);
  const out = [40 * n[0] + n[1]];
  for (const v of n.slice(2)) {
    const b = [v & 0x7f];
    for (let x = v >> 7; x; x >>= 7) b.unshift((x & 0x7f) | 0x80);
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s) => tlv(0x0c, Buffer.from(s));
const time = (d) => tlv(0x18, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'));

export function selfSigned(host = 'board.test') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const alg = seq(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const name = seq(set(seq(oid('2.5.4.3'), utf8(host))));
  const serial = randomBytes(8);
  serial[0] &= 0x7f;
  const san = seq(oid('2.5.29.17'), tlv(0x04, seq(tlv(0x82, Buffer.from(host)), tlv(0x87, Buffer.from([127, 0, 0, 1])))));
  const basic = seq(oid('2.5.29.19'), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq(tlv(0x01, Buffer.from([0xff])))));
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    alg,
    name,
    seq(time(new Date(Date.now() - 86400_000)), time(new Date(Date.now() + 10 * 86400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(basic, san)),
  );
  const sig = sign('sha256', tbs, privateKey);
  const der = seq(tbs, alg, tlv(0x03, Buffer.from([0]), sig));
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  new X509Certificate(cert); // throws if malformed
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
