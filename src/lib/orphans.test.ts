import { describe, expect, it } from 'vitest';
import { groupByAccount, orderForDeletion,Orphan } from './orphans';

function orphan(kind: string, name: string, account = 'gone'): Orphan {
  return {
    id: `${kind}/${name}`,
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind,
    name,
    account,
    reason: 'test',
  };
}

describe('orderForDeletion', () => {
  it('removes bindings before the roles they reference', () => {
    const ordered = orderForDeletion([
      orphan('ClusterRole', 'r'),
      orphan('Secret', 's'),
      orphan('RoleBinding', 'rb'),
      orphan('Role', 'role'),
      orphan('ClusterRoleBinding', 'crb'),
    ]).map(o => o.kind);

    expect(ordered.indexOf('RoleBinding')).toBeLessThan(ordered.indexOf('Role'));
    expect(ordered.indexOf('ClusterRoleBinding')).toBeLessThan(ordered.indexOf('ClusterRole'));
  });

  it('does not mutate the input', () => {
    const input = [orphan('ClusterRole', 'r'), orphan('RoleBinding', 'rb')];
    const before = input.map(o => o.kind);
    orderForDeletion(input);
    expect(input.map(o => o.kind)).toEqual(before);
  });

  it('handles an empty list', () => {
    expect(orderForDeletion([])).toEqual([]);
  });
});

describe('groupByAccount', () => {
  it('collects every object under the account it claims', () => {
    const grouped = groupByAccount([
      orphan('Role', 'a-role', 'a'),
      orphan('RoleBinding', 'a-binding', 'a'),
      orphan('Secret', 'b-token', 'b'),
    ]);
    expect(grouped.size).toBe(2);
    expect(grouped.get('a')).toHaveLength(2);
    expect(grouped.get('b')).toHaveLength(1);
  });

  it('is empty for no orphans', () => {
    expect(groupByAccount([]).size).toBe(0);
  });
});
