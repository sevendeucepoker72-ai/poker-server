/**
 * R2 (2026-10-11) — OPS-6: every per-IP check keys on the REAL client address.
 *
 * On Railway `socket.handshake.address` is the edge proxy hop (100.64.0.0/10,
 * different per connection): the per-IP connection cap, the same-network seat
 * block and the qualifier per-device cap keyed on it did nothing against a real
 * abuser (a live probe held 25 sockets from one address against a cap of 5) and
 * could refuse strangers sharing a hop. X-Real-IP (the edge overwrites it) wins,
 * then the first X-Forwarded-For entry, then the peer address.
 */
import { clientIpFromHandshake, normalizeIp } from '../src/net/clientIp';
import { SRC } from './helpers/indexSource';

describe('clientIpFromHandshake', () => {
  it('X-Real-IP first — even when X-Forwarded-For names someone else', () => {
    expect(clientIpFromHandshake({
      address: '100.64.0.7', headers: { 'x-real-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1, 100.64.0.7' },
    })).toBe('203.0.113.9');
  });

  it('then the FIRST X-Forwarded-For entry (string or array form)', () => {
    expect(clientIpFromHandshake({ address: '100.64.0.7', headers: { 'x-forwarded-for': '198.51.100.1, 100.64.0.7' } })).toBe('198.51.100.1');
    expect(clientIpFromHandshake({ address: '100.64.0.7', headers: { 'x-forwarded-for': ['198.51.100.2, 10.0.0.1', '1.1.1.1'] } })).toBe('198.51.100.2');
  });

  it('then the peer address (local dev / direct)', () => {
    expect(clientIpFromHandshake({ address: '127.0.0.1', headers: {} })).toBe('127.0.0.1');
    expect(clientIpFromHandshake({ address: '::ffff:127.0.0.1', headers: { 'x-real-ip': '  ' } })).toBe('127.0.0.1');
    expect(clientIpFromHandshake(undefined)).toBe('');
  });

  it('one address is one key: trimmed, IPv4-mapped prefix dropped, length capped', () => {
    expect(normalizeIp(' ::ffff:203.0.113.9 ')).toBe('203.0.113.9');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
    expect(normalizeIp('x'.repeat(500)).length).toBe(64);
  });

  it('two players behind DIFFERENT proxy hops but the same real address share one key; two strangers on one hop do not', () => {
    const a = clientIpFromHandshake({ address: '100.64.0.1', headers: { 'x-real-ip': '203.0.113.9' } });
    const b = clientIpFromHandshake({ address: '100.64.0.2', headers: { 'x-real-ip': '203.0.113.9' } });
    const c = clientIpFromHandshake({ address: '100.64.0.1', headers: { 'x-real-ip': '198.51.100.4' } });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });
});

describe('wiring — the three per-IP checks use realClientIp, never handshake.address', () => {
  it('realClientIp delegates to clientIpFromHandshake', () => {
    expect(SRC).toContain('return clientIpFromHandshake(socket.handshake as any);');
  });
  it('the connection cap + the same-network seat block key (clientIp) is the real address', () => {
    expect(SRC).toContain('const clientIp = realClientIp(socket);');
    expect(SRC).toContain('ipSeatedSlots.set(clientIp, new Set())');
  });
  it('the qualifier per-device cap', () => {
    expect(SRC).toContain('const regIp = realClientIp(socket);');
  });
  it('nothing keys a check on the bare proxy hop any more', () => {
    const uses = SRC.split('\n').filter((l) => l.includes('socket.handshake.address') && !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    expect(uses).toEqual([]);
  });
});
