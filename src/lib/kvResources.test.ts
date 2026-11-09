import { describe, expect, it } from 'vitest';
import { filterKvItems, isDnsSubdomain, withRequiredKeys } from './kvResources';

describe('withRequiredKeys', () => {
  const blank = (key: string) => ({ key, value: '' });

  it('keeps keys outside the required set — a TLS Secret keeps its ca.crt', () => {
    const rows = withRequiredKeys(
      [
        { key: 'ca.crt', value: 'CA' },
        { key: 'tls.key', value: 'KEY' },
      ],
      ['tls.crt', 'tls.key'],
      blank,
    );
    expect(rows).toEqual([
      { key: 'tls.crt', value: '' },
      { key: 'tls.key', value: 'KEY' },
      { key: 'ca.crt', value: 'CA' },
    ]);
  });

  it('drops blank rows instead of carrying them along', () => {
    const rows = withRequiredKeys([{ key: '', value: '' }], ['username', 'password'], blank);
    expect(rows.map(r => r.key)).toEqual(['username', 'password']);
  });

  it('drops the previous type\'s empty keys when switching TLS to basic auth', () => {
    const rows = withRequiredKeys(
      [
        { key: 'tls.crt', value: '' },
        { key: 'tls.key', value: '' },
      ],
      ['username', 'password'],
      blank,
    );
    expect(rows.map(r => r.key)).toEqual(['username', 'password']);
  });
});

describe('isDnsSubdomain', () => {
  it.each(['a', 'my-config', 'app.v1', 'a1-b2.c3'])('accepts %s', name => {
    expect(isDnsSubdomain(name)).toBe(true);
  });

  it.each(['', '-a', 'a-', 'a.', '.a', 'A', 'a_b', 'a..b'])('rejects "%s"', name => {
    expect(isDnsSubdomain(name)).toBe(false);
  });

  it('rejects names over 253 characters', () => {
    expect(isDnsSubdomain('a'.repeat(253))).toBe(true);
    expect(isDnsSubdomain('a'.repeat(254))).toBe(false);
  });
});

describe('filterKvItems', () => {
  const item = (namespace: string, name: string) => ({ metadata: { namespace, name } });
  const items = [item('b', 'two'), item('a', 'one'), item('a', 'kube-root-ca.crt')];
  const isSystem = (i: { metadata: { name: string } }) => i.metadata.name === 'kube-root-ca.crt';

  it('hides system objects, sorts by namespace/name and matches text on either', () => {
    const out = filterKvItems(items, { hideSystem: true, isSystem, namespaces: [], text: '' });
    expect(out.map(i => `${i.metadata.namespace}/${i.metadata.name}`)).toEqual(['a/one', 'b/two']);
    expect(
      filterKvItems(items, { hideSystem: false, isSystem, namespaces: [], text: 'TW' }),
    ).toEqual([item('b', 'two')]);
  });

  it('keeps only the active namespaces when some are set', () => {
    const out = filterKvItems(items, { hideSystem: false, isSystem, namespaces: ['a'], text: '' });
    expect(out.every(i => i.metadata.namespace === 'a')).toBe(true);
  });
});
