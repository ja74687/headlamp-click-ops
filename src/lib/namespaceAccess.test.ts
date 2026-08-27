import { describe, expect, it } from 'vitest';
import { describeSubject, isFullAccess, isWriteCapable, summariseRules } from './namespaceAccess';
import { Rule } from './rbac';

const readOnly: Rule[] = [
  { apiGroups: [''], resources: ['pods', 'services'], verbs: ['get', 'list', 'watch'] },
];
const readWrite: Rule[] = [
  { apiGroups: ['apps'], resources: ['deployments'], verbs: ['get', 'list', 'update'] },
];
const clusterAdmin: Rule[] = [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }];

describe('isWriteCapable', () => {
  it('is false for get/list/watch', () => {
    expect(isWriteCapable(readOnly)).toBe(false);
  });

  it('is true as soon as one rule can mutate', () => {
    expect(isWriteCapable(readWrite)).toBe(true);
  });

  it('treats the wildcard verb as write', () => {
    expect(isWriteCapable(clusterAdmin)).toBe(true);
  });

  it('is false for no rules at all', () => {
    expect(isWriteCapable([])).toBe(false);
  });

  it('catches deletecollection, which is easy to overlook', () => {
    expect(
      isWriteCapable([{ apiGroups: [''], resources: ['pods'], verbs: ['deletecollection'] }]),
    ).toBe(true);
  });
});

describe('isFullAccess', () => {
  it('recognises the cluster-admin shape', () => {
    expect(isFullAccess(clusterAdmin)).toBe(true);
  });

  it('does not flag a wide read-only grant as full access', () => {
    expect(isFullAccess([{ apiGroups: ['*'], resources: ['*'], verbs: ['get', 'list'] }])).toBe(
      false,
    );
  });

  it('needs the wildcards on the same rule, not spread across two', () => {
    expect(
      isFullAccess([
        { apiGroups: ['*'], resources: ['pods'], verbs: ['*'] },
        { apiGroups: [''], resources: ['*'], verbs: ['get'] },
      ]),
    ).toBe(false);
  });
});

describe('summariseRules', () => {
  it('says so when there is nothing', () => {
    expect(summariseRules([])).toBe('no rules');
  });

  it('calls out full access instead of listing wildcards', () => {
    expect(summariseRules(clusterAdmin)).toBe('full access');
  });

  it('distinguishes read-only from read/write', () => {
    expect(summariseRules(readOnly)).toContain('read-only');
    expect(summariseRules(readWrite)).toContain('read/write');
  });

  it('truncates a long resource list rather than filling the cell', () => {
    const many: Rule[] = [
      {
        apiGroups: [''],
        resources: ['a', 'b', 'c', 'd', 'e', 'f'],
        verbs: ['get'],
      },
    ];
    expect(summariseRules(many)).toContain('+2 more');
  });
});

describe('describeSubject', () => {
  it('renders a ServiceAccount as the username RBAC actually matches', () => {
    expect(describeSubject({ kind: 'ServiceAccount', name: 'dev', namespace: 'default' })).toBe(
      'system:serviceaccount:default:dev',
    );
  });

  it('falls back to kind/name for users and groups', () => {
    expect(describeSubject({ kind: 'Group', name: 'system:masters' })).toBe(
      'Group/system:masters',
    );
  });
});
