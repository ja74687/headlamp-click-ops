import { describe, expect, it } from 'vitest';
import { ManagedAccount } from './discovery';
import { destructiveChanges, ownsRoleName, planChanges, staleRoleNamespaces } from './plan';
import { BuildInput, deriveNames, UiAccessLevel } from './rbac';

function account(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    name: 'dev-user',
    namespace: 'default',
    scope: 'Namespaced',
    roleKind: 'ClusterRole',
    roleName: 'dev-user-role',
    tokenSecretName: 'dev-user-token',
    clusterReadName: 'dev-user-cluster-read',
    uiAccess: 'namespaces',
    bindings: [
      { namespace: 'a', name: 'dev-user-binding-a' },
      { namespace: 'b', name: 'dev-user-binding-b' },
    ],
    bindingNamespaces: ['a', 'b'],
    rules: [],
    ...overrides,
  };
}

function desired(namespaces: string[], uiAccess: UiAccessLevel = 'namespaces'): BuildInput {
  return {
    scope: 'Namespaced',
    namespaces,
    tokenNamespace: 'default',
    ...deriveNames('dev-user'),
    uiAccess,
    rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get'] }],
  };
}

describe('planChanges', () => {
  it('plans a delete for a namespace that was dropped', () => {
    // Three namespaces down to two keeps the role a ClusterRole, so the only deletion in
    // play is the binding itself — dropping to one namespace would also swap the role kind.
    const three = account({
      bindings: [
        { namespace: 'a', name: 'dev-user-binding-a' },
        { namespace: 'b', name: 'dev-user-binding-b' },
        { namespace: 'c', name: 'dev-user-binding-c' },
      ],
      bindingNamespaces: ['a', 'b', 'c'],
    });
    const del = planChanges(three, desired(['a', 'c'])).filter(c => c.action === 'delete');
    expect(del).toHaveLength(1);
    expect(del[0]).toMatchObject({
      kind: 'RoleBinding',
      name: 'dev-user-binding-b',
      namespace: 'b',
    });
    expect(del[0].reason).toContain('b');
  });

  it('also drops the old ClusterRole when shrinking to a single namespace', () => {
    // One namespace means a plain Role, and the ClusterRole it replaces has to go.
    const changes = planChanges(account(), desired(['a']));
    expect(changes.filter(c => c.action === 'delete').map(c => c.kind).sort()).toEqual([
      'ClusterRole',
      'RoleBinding',
    ]);
  });

  it('plans a create for a namespace that was added', () => {
    const changes = planChanges(account(), desired(['a', 'b', 'c']));
    const created = changes.filter(c => c.action === 'create' && c.kind === 'RoleBinding');
    expect(created.map(c => c.namespace)).toEqual(['c']);
  });

  it('deletes nothing when the namespace set is unchanged', () => {
    expect(destructiveChanges(planChanges(account(), desired(['a', 'b'])))).toEqual([]);
  });

  it('recreates every binding when the role kind flips, since roleRef is immutable', () => {
    const single = planChanges(
      account({ roleKind: 'ClusterRole' }),
      desired(['a']),
    );
    // Two namespaces down to one means a Role replaces the ClusterRole.
    expect(single.some(c => c.action === 'recreate')).toBe(true);
    expect(
      single.some(c => c.action === 'delete' && c.kind === 'ClusterRole'),
    ).toBe(true);
  });

  it('plans the cluster-read bundle removal when UI access is turned off', () => {
    const changes = planChanges(account(), desired(['a', 'b'], 'none'));
    const deleted = changes.filter(c => c.action === 'delete').map(c => c.kind);
    expect(deleted).toContain('ClusterRole');
    expect(deleted).toContain('ClusterRoleBinding');
  });

  it('creates the bundle when UI access is switched on from none', () => {
    const changes = planChanges(account({ uiAccess: 'none' }), desired(['a', 'b'], 'metrics'));
    const created = changes.filter(
      c => c.action === 'create' && c.name === 'dev-user-cluster-read',
    );
    expect(created).toHaveLength(2);
  });

  it('explains an access level change in terms of both levels', () => {
    const changes = planChanges(account({ uiAccess: 'namespaces' }), desired(['a', 'b'], 'kubelet'));
    const bundle = changes.find(c => c.name === 'dev-user-cluster-read');
    expect(bundle?.reason).toContain('namespaces');
    expect(bundle?.reason).toContain('kubelet');
  });
});

describe('staleRoleNamespaces', () => {
  const singleRole = (ns: string) =>
    account({
      roleKind: 'Role',
      bindings: [{ namespace: ns, name: `dev-user-binding-${ns}` }],
      bindingNamespaces: [ns],
    });

  it('names the old namespace when a Role account moves to another one', () => {
    expect(staleRoleNamespaces(singleRole('a'), desired(['b']))).toEqual(['a']);
  });

  it('is empty when the account stays where it is', () => {
    expect(staleRoleNamespaces(singleRole('a'), desired(['a']))).toEqual([]);
  });

  it('leaves a role kind change to the kind-change path', () => {
    // Role -> ClusterRole deletes the old Role through deleteRole already.
    expect(staleRoleNamespaces(singleRole('a'), desired(['a', 'b']))).toEqual([]);
    expect(staleRoleNamespaces(account(), desired(['a']))).toEqual([]);
  });

  it('never names a role the plugin did not make', () => {
    // Discovery took the role from a hand-made binding to a shared Role.
    const shared = account({
      roleKind: 'Role',
      roleName: 'app-reader',
      bindings: [{ namespace: 'apps', name: 'dev-reads-apps' }],
      bindingNamespaces: ['apps'],
    });
    expect(staleRoleNamespaces(shared, desired(['team']))).toEqual([]);
    expect(planChanges(shared, desired(['team'])).some(c => c.name === 'app-reader')).toBe(false);
  });

  it('shows up in the plan as a delete', () => {
    const del = planChanges(singleRole('a'), desired(['b'])).filter(c => c.action === 'delete');
    expect(del).toContainEqual(
      expect.objectContaining({ kind: 'Role', name: 'dev-user-role', namespace: 'a' }),
    );
  });
});

describe('role deletion on a kind change', () => {
  it('is planned for the role the plugin made for the account', () => {
    const del = planChanges(account(), desired(['a'])).filter(c => c.action === 'delete');
    expect(del.some(c => c.kind === 'ClusterRole' && c.name === 'dev-user-role')).toBe(true);
  });

  it('is not planned when the role came from a hand-made binding, e.g. cluster-admin', () => {
    const changes = planChanges(account({ roleName: 'cluster-admin' }), desired(['a']));
    expect(changes.some(c => c.action === 'delete' && c.name === 'cluster-admin')).toBe(false);
  });
});

describe('destructiveChanges', () => {
  it('counts deletes and recreates, not creates and updates', () => {
    const changes = planChanges(account(), desired(['a']));
    for (const c of destructiveChanges(changes)) {
      expect(['delete', 'recreate']).toContain(c.action);
    }
  });
});

describe('ownsRoleName', () => {
  it('accepts only the role name the plugin derives for the account', () => {
    expect(ownsRoleName(account())).toBe(true);
    expect(ownsRoleName(account({ roleName: 'view' }))).toBe(false);
  });
});
