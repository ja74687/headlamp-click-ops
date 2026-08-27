import { describe, expect, it } from 'vitest';
import { buildChecks, isBlocking, serviceAccountUser } from './accessCheck';

const target = {
  namespace: 'default',
  name: 'dev-user',
  boundNamespaces: ['a', 'b', 'c', 'd', 'e'],
  scope: 'Namespaced' as const,
};

describe('serviceAccountUser', () => {
  it('builds the username the API server matches RBAC against', () => {
    expect(serviceAccountUser('default', 'dev-user')).toBe(
      'system:serviceaccount:default:dev-user',
    );
  });
});

describe('buildChecks', () => {
  it('treats only the namespace list and the bound namespaces as required', () => {
    const required = buildChecks(target)
      .filter(c => !c.optional)
      .map(c => c.id);
    expect(required).toContain('namespaces');
    expect(required).toContain('pods-in-a');
    expect(required).not.toContain('nodeproxy');
  });

  it('caps per-namespace checks so a wide account does not fan out', () => {
    const perNamespace = buildChecks(target).filter(c => c.id.startsWith('pods-in-'));
    expect(perNamespace).toHaveLength(3);
  });

  it('skips per-namespace checks for a cluster-wide account', () => {
    const checks = buildChecks({ ...target, scope: 'Cluster' });
    expect(checks.some(c => c.id.startsWith('pods-in-'))).toBe(false);
  });

  it('asks about nodes/proxy as a subresource rather than a resource name', () => {
    const proxy = buildChecks(target).find(c => c.id === 'nodeproxy');
    expect(proxy?.attrs.resource).toBe('nodes');
    expect(proxy?.attrs.subresource).toBe('proxy');
  });

  it('scopes the cluster-wide checks to no namespace', () => {
    const nsCheck = buildChecks(target).find(c => c.id === 'namespaces');
    expect(nsCheck?.attrs.namespace).toBeUndefined();
  });
});

describe('isBlocking', () => {
  const base = buildChecks(target).find(c => c.id === 'namespaces')!;
  const optional = buildChecks(target).find(c => c.id === 'pods')!;

  it('flags a denied required check', () => {
    expect(isBlocking({ ...base, allowed: false })).toBe(true);
  });

  it('does not flag a denied optional check', () => {
    expect(isBlocking({ ...optional, allowed: false })).toBe(false);
  });

  it('does not flag an undetermined check — unknown is not denied', () => {
    expect(isBlocking({ ...base, allowed: null })).toBe(false);
  });
});
