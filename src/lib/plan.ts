import { ManagedAccount } from './discovery';
import {
  buildBindings,
  BuildInput,
  buildRole,
  buildServiceAccount,
  buildTokenSecret,
  buildUiClusterRead,
  deriveNames,
  roleKind,
} from './rbac';

/**
 * What applying an edit will actually do to the cluster.
 *
 * The reconciler already encodes this, but only as side effects — the YAML preview shows the
 * desired end state and says nothing about what gets deleted. Deletions are the part worth
 * seeing before you click, since a removed namespace means a binding disappears.
 */

export type ChangeAction = 'create' | 'update' | 'delete' | 'recreate';

export type PlannedChange = {
  action: ChangeAction;
  kind: string;
  name: string;
  namespace?: string;
  /** Why this step exists, in the terms the user was thinking in. */
  reason: string;
};

function key(kind: string, name: string, namespace?: string): string {
  return `${kind}/${namespace ?? ''}/${name}`;
}

export function planChanges(current: ManagedAccount, desired: BuildInput): PlannedChange[] {
  const changes: PlannedChange[] = [];

  const desiredRoleKind = roleKind(desired);
  const roleKindChanged =
    (current.bindings.length > 0 || current.clusterBindingName) &&
    current.roleKind !== desiredRoleKind;

  changes.push({
    action: 'update',
    kind: 'ServiceAccount',
    name: buildServiceAccount(desired).metadata.name,
    namespace: desired.tokenNamespace,
    reason: 'unchanged identity, re-applied',
  });
  changes.push({
    action: 'update',
    kind: 'Secret',
    name: buildTokenSecret(desired).metadata.name,
    namespace: desired.tokenNamespace,
    reason: 'long-lived token Secret',
  });

  const role = buildRole(desired);
  changes.push({
    action: roleKindChanged ? 'create' : 'update',
    kind: role.kind,
    name: role.metadata.name,
    namespace: (role.metadata as any).namespace,
    reason: roleKindChanged
      ? `scope change: ${current.roleKind} becomes ${desiredRoleKind}`
      : 'permission rules',
  });

  const desiredBindings = buildBindings(desired);
  const desiredKeys = new Set(
    desiredBindings.map(b => key(b.kind, b.metadata.name, (b.metadata as any).namespace)),
  );
  const currentKeys = new Set(current.bindings.map(b => key('RoleBinding', b.name, b.namespace)));
  if (current.clusterBindingName) {
    currentKeys.add(key('ClusterRoleBinding', current.clusterBindingName));
  }

  for (const b of desiredBindings) {
    const namespace = (b.metadata as any).namespace as string | undefined;
    const k = key(b.kind, b.metadata.name, namespace);
    const existed = currentKeys.has(k);
    changes.push({
      action: roleKindChanged && existed ? 'recreate' : existed ? 'update' : 'create',
      kind: b.kind,
      name: b.metadata.name,
      namespace,
      reason:
        roleKindChanged && existed
          ? 'roleRef is immutable, so the binding is deleted and recreated'
          : existed
            ? 'already bound'
            : `grants access to ${namespace ?? 'the whole cluster'}`,
    });
  }

  for (const b of current.bindings) {
    if (!desiredKeys.has(key('RoleBinding', b.name, b.namespace))) {
      changes.push({
        action: 'delete',
        kind: 'RoleBinding',
        name: b.name,
        namespace: b.namespace,
        reason: `${b.namespace} is no longer selected — access there is removed`,
      });
    }
  }
  if (
    current.clusterBindingName &&
    !desiredKeys.has(key('ClusterRoleBinding', current.clusterBindingName))
  ) {
    changes.push({
      action: 'delete',
      kind: 'ClusterRoleBinding',
      name: current.clusterBindingName,
      reason: 'no longer cluster-wide',
    });
  }

  const uiResources = buildUiClusterRead(desired);
  if (uiResources.length > 0) {
    for (const r of uiResources) {
      changes.push({
        action: current.uiAccess === 'none' ? 'create' : 'update',
        kind: r.kind,
        name: r.metadata.name,
        reason:
          current.uiAccess === desired.uiAccess
            ? 'Headlamp UI access, unchanged'
            : `Headlamp UI access: ${current.uiAccess} becomes ${desired.uiAccess}`,
      });
    }
  } else if (current.uiAccess !== 'none') {
    changes.push({
      action: 'delete',
      kind: 'ClusterRoleBinding',
      name: current.clusterReadName,
      reason: 'Headlamp UI access turned off',
    });
    changes.push({
      action: 'delete',
      kind: 'ClusterRole',
      name: current.clusterReadName,
      reason: 'Headlamp UI access turned off',
    });
  }

  if (roleKindChanged && ownsRoleName(current)) {
    changes.push({
      action: 'delete',
      kind: current.roleKind,
      name: current.roleName,
      namespace: current.roleKind === 'Role' ? current.bindings[0]?.namespace : undefined,
      reason: 'replaced by the new role kind',
    });
  }

  for (const ns of staleRoleNamespaces(current, desired)) {
    changes.push({
      action: 'delete',
      kind: 'Role',
      name: current.roleName,
      namespace: ns,
      reason: `the account moved out of ${ns}, so its Role there goes too`,
    });
  }

  return changes;
}

/**
 * Namespaces still holding the account's Role after an edit that keeps it a Role.
 *
 * A Role sits next to the account's single binding; moving the account to another namespace
 * creates the Role there, and without this the old one stays behind.
 */
export function staleRoleNamespaces(current: ManagedAccount, desired: BuildInput): string[] {
  if (current.roleKind !== 'Role' || roleKind(desired) !== 'Role') return [];
  if (!ownsRoleName(current)) return [];
  const kept = desired.namespaces[0];
  return [...new Set(current.bindings.map(b => b.namespace))].filter(ns => ns !== kept);
}

/**
 * Whether the account's role is the one this plugin made for it. Discovery takes the role
 * name from the first binding that matches, and a binding someone made by hand can point at
 * a shared role or a built-in like `cluster-admin` — deleting that would hit every other
 * subject bound to it. The delete itself also checks the labels (`deleteIfLabelled`).
 */
export function ownsRoleName(current: ManagedAccount): boolean {
  return current.roleName === deriveNames(current.name).roleName;
}

/** Changes that take access away, which is what deserves a second look before applying. */
export function destructiveChanges(changes: PlannedChange[]): PlannedChange[] {
  return changes.filter(c => c.action === 'delete' || c.action === 'recreate');
}
