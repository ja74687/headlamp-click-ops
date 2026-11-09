import { describe, expect, it } from 'vitest';
import {
  buildChecks,
  isBlocking,
  representativeAttrs,
  serviceAccountGroups,
  serviceAccountUser,
} from './accessCheck';

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
    expect(required).toContain('work-in-a');
    expect(required).not.toContain('nodeproxy');
  });

  it('caps per-namespace checks so a wide account does not fan out', () => {
    const perNamespace = buildChecks(target).filter(c => c.id.startsWith('work-in-'));
    expect(perNamespace).toHaveLength(3);
  });

  it('skips per-namespace checks for a cluster-wide account', () => {
    const checks = buildChecks({ ...target, scope: 'Cluster' });
    expect(checks.some(c => c.id.startsWith('work-in-'))).toBe(false);
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

describe('serviceAccountGroups', () => {
  it('lists the groups a ServiceAccount token authenticates with', () => {
    expect(serviceAccountGroups('team-a')).toEqual([
      'system:serviceaccounts',
      'system:serviceaccounts:team-a',
      'system:authenticated',
    ]);
  });
});

describe('representativeAttrs', () => {
  it('checks something the account was actually given, not pods for everyone', () => {
    const attrs = representativeAttrs([
      { apiGroups: [''], resources: ['configmaps'], verbs: ['get', 'list'] },
    ]);
    expect(attrs).toEqual({ verb: 'list', group: '', resource: 'configmaps' });
  });

  it('splits a subresource the way SubjectAccessReview expects it', () => {
    const attrs = representativeAttrs([
      { apiGroups: [''], resources: ['pods/exec'], verbs: ['create'] },
    ]);
    expect(attrs).toEqual({ verb: 'create', group: '', resource: 'pods', subresource: 'exec' });
  });

  it('passes wildcards through, since RBAC matches a requested * only against its own *', () => {
    const attrs = representativeAttrs([{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }]);
    expect(attrs).toEqual({ verb: '*', group: '*', resource: '*' });
  });

  it('falls back to listing pods when there are no usable rules', () => {
    expect(representativeAttrs([])).toEqual({ verb: 'list', group: '', resource: 'pods' });
    expect(representativeAttrs([{ apiGroups: [''], resources: [], verbs: ['get'] }])).toEqual({
      verb: 'list',
      group: '',
      resource: 'pods',
    });
  });

  it('feeds the per-namespace checks', () => {
    const checks = buildChecks({
      ...target,
      rules: [{ apiGroups: ['apps'], resources: ['deployments'], verbs: ['get'] }],
    });
    const inA = checks.find(c => c.id === 'work-in-a');
    expect(inA?.attrs).toEqual({ verb: 'get', group: 'apps', resource: 'deployments', namespace: 'a' });
    expect(inA?.label).toBe('get deployments in a');
  });
});
