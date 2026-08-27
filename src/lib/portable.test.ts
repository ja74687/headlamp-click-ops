import { describe, expect, it } from 'vitest';
import { ManagedAccount } from './discovery';
import {
  exportBundle,
  missingNamespaces,
  parseBundle,
  PORTABLE_VERSION,
  toPortable,
} from './portable';

const account: ManagedAccount = {
  name: 'dev-user',
  namespace: 'default',
  scope: 'Namespaced',
  roleKind: 'ClusterRole',
  roleName: 'dev-user-role',
  tokenSecretName: 'dev-user-token',
  clusterReadName: 'dev-user-cluster-read',
  uiAccess: 'metrics',
  bindings: [{ namespace: 'a', name: 'dev-user-binding-a' }],
  bindingNamespaces: ['a'],
  rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get'] }],
};

describe('toPortable', () => {
  it('keeps what defines the account', () => {
    expect(toPortable(account)).toEqual({
      name: 'dev-user',
      namespace: 'default',
      scope: 'Namespaced',
      namespaces: ['a'],
      uiAccess: 'metrics',
      rules: account.rules,
    });
  });

  it('carries no credential or cluster-specific field', () => {
    const text = JSON.stringify(toPortable(account));
    expect(text).not.toContain('token');
    expect(text).not.toContain('binding');
  });
});

describe('round trip', () => {
  it('survives export and re-import unchanged', () => {
    const parsed = parseBundle(exportBundle([account]));
    expect(parsed.errors).toEqual([]);
    expect(parsed.bundle?.accounts).toEqual([toPortable(account)]);
  });
});

describe('parseBundle', () => {
  it('rejects a file from a future version rather than guessing', () => {
    const result = parseBundle(`version: 999\naccounts: []\n`);
    expect(result.bundle).toBeNull();
    expect(result.errors[0]).toContain('Unsupported version');
  });

  it('rejects input that is not YAML', () => {
    expect(parseBundle('\tnot: [valid').bundle).toBeNull();
  });

  it('rejects an empty document', () => {
    expect(parseBundle('').bundle).toBeNull();
  });

  it('skips an entry with no name but keeps the good ones', () => {
    const result = parseBundle(`
version: ${PORTABLE_VERSION}
accounts:
  - namespace: default
    namespaces: [a]
    rules: [{apiGroups: [''], resources: [pods], verbs: [get]}]
  - name: good
    namespace: default
    namespaces: [a]
    rules: [{apiGroups: [''], resources: [pods], verbs: [get]}]
`);
    expect(result.bundle?.accounts.map(a => a.name)).toEqual(['good']);
    expect(result.errors.join(' ')).toContain('missing a name');
  });

  it('refuses a namespaced account with no namespaces', () => {
    const result = parseBundle(`
version: ${PORTABLE_VERSION}
accounts:
  - name: x
    namespace: default
    namespaces: []
    rules: [{apiGroups: [''], resources: [pods], verbs: [get]}]
`);
    expect(result.bundle?.accounts).toEqual([]);
    expect(result.errors.join(' ')).toContain('at least one namespace');
  });

  it('falls back to a safe uiAccess and says so', () => {
    const result = parseBundle(`
version: ${PORTABLE_VERSION}
accounts:
  - name: x
    namespace: default
    namespaces: [a]
    uiAccess: root
    rules: [{apiGroups: [''], resources: [pods], verbs: [get]}]
`);
    expect(result.bundle?.accounts[0].uiAccess).toBe('namespaces');
    expect(result.errors.join(' ')).toContain('unknown uiAccess');
  });

  it('drops a duplicate rather than applying it twice', () => {
    const one = `  - name: x
    namespace: default
    namespaces: [a]
    rules: [{apiGroups: [''], resources: [pods], verbs: [get]}]`;
    const result = parseBundle(`version: ${PORTABLE_VERSION}\naccounts:\n${one}\n${one}\n`);
    expect(result.bundle?.accounts).toHaveLength(1);
    expect(result.errors.join(' ')).toContain('duplicate');
  });

  it('skips an account whose rules are malformed instead of granting nothing silently', () => {
    const result = parseBundle(`
version: ${PORTABLE_VERSION}
accounts:
  - name: x
    namespace: default
    namespaces: [a]
    rules: [{resources: [pods]}]
`);
    expect(result.bundle?.accounts).toEqual([]);
    expect(result.errors.join(' ')).toContain('apiGroups');
  });
});

describe('missingNamespaces', () => {
  it('reports namespaces the target cluster does not have', () => {
    const accounts = [toPortable(account)];
    expect(missingNamespaces(accounts, ['default'])).toEqual(['a']);
  });

  it('includes the ServiceAccount namespace, not just the bound ones', () => {
    expect(missingNamespaces([toPortable(account)], ['a'])).toEqual(['default']);
  });

  it('is empty when everything exists', () => {
    expect(missingNamespaces([toPortable(account)], ['default', 'a'])).toEqual([]);
  });
});
