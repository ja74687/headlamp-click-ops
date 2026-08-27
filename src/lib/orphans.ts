import { request } from '@kinvolk/headlamp-plugin/lib/ApiProxy';
import { deleteResource } from './apply';
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE, PURPOSE_LABEL } from './rbac';

/**
 * Objects this plugin created whose ServiceAccount is gone.
 *
 * They appear when a delete is interrupted part-way, when someone removes the
 * ServiceAccount by hand, or when an older build left something behind. A stale
 * RoleBinding is not harmless: recreating a ServiceAccount with the same name in the same
 * namespace silently hands the new account every permission the old one had.
 */

const LABEL_SELECTOR = `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`;

export type Orphan = {
  id: string;
  apiVersion: string;
  kind: string;
  name: string;
  namespace?: string;
  /** The account the object claims to belong to, which no longer exists. */
  account: string;
  reason: string;
};

type AnyObject = { metadata: any; [k: string]: any };

async function listManaged(url: string): Promise<{ items: AnyObject[]; error: string | null }> {
  try {
    const res: any = await request(`${url}?labelSelector=${encodeURIComponent(LABEL_SELECTOR)}`);
    return { items: (res?.items as AnyObject[]) ?? [], error: null };
  } catch (err) {
    return { items: [], error: `${url}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function accountOf(obj: AnyObject): string | null {
  const labels = obj.metadata?.labels ?? {};
  return labels['access-builder/account'] ?? labels['access-builder/for-account'] ?? null;
}

export type OrphanReport = {
  orphans: Orphan[];
  errors: string[];
};

export async function findOrphans(): Promise<OrphanReport> {
  const [sas, secrets, roles, roleBindings, clusterRoles, clusterRoleBindings] = await Promise.all([
    listManaged('/api/v1/serviceaccounts'),
    listManaged('/api/v1/secrets'),
    listManaged('/apis/rbac.authorization.k8s.io/v1/roles'),
    listManaged('/apis/rbac.authorization.k8s.io/v1/rolebindings'),
    listManaged('/apis/rbac.authorization.k8s.io/v1/clusterroles'),
    listManaged('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings'),
  ]);

  const errors = [sas, secrets, roles, roleBindings, clusterRoles, clusterRoleBindings]
    .map(r => r.error)
    .filter((e): e is string => e !== null);

  // An account is identified by name only: that is the same key the naming convention and
  // the labels use, and it is what a recreated ServiceAccount would collide with.
  const liveAccounts = new Set(sas.items.map(sa => sa.metadata.name as string));

  const orphans: Orphan[] = [];

  const consider = (
    obj: AnyObject,
    apiVersion: string,
    kind: string,
    namespaced: boolean,
  ): void => {
    const account = accountOf(obj);
    if (!account || liveAccounts.has(account)) return;
    const namespace = namespaced ? (obj.metadata.namespace as string) : undefined;
    orphans.push({
      id: `${kind}/${namespace ?? ''}/${obj.metadata.name}`,
      apiVersion,
      kind,
      name: obj.metadata.name,
      namespace,
      account,
      reason: obj.metadata?.labels?.[PURPOSE_LABEL]
        ? `UI helper for "${account}", which no longer exists`
        : `belongs to "${account}", which no longer exists`,
    });
  };

  for (const s of secrets.items) consider(s, 'v1', 'Secret', true);
  for (const r of roles.items) consider(r, 'rbac.authorization.k8s.io/v1', 'Role', true);
  for (const rb of roleBindings.items) {
    consider(rb, 'rbac.authorization.k8s.io/v1', 'RoleBinding', true);
  }
  for (const cr of clusterRoles.items) {
    consider(cr, 'rbac.authorization.k8s.io/v1', 'ClusterRole', false);
  }
  for (const crb of clusterRoleBindings.items) {
    consider(crb, 'rbac.authorization.k8s.io/v1', 'ClusterRoleBinding', false);
  }

  return { orphans: orphans.sort(compareOrphans), errors };
}

function compareOrphans(a: Orphan, b: Orphan): number {
  if (a.account !== b.account) return a.account.localeCompare(b.account);
  if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
  return a.name.localeCompare(b.name);
}

export type CleanupOutcome = {
  orphan: Orphan;
  ok: boolean;
  error?: string;
};

/**
 * Bindings go before the roles they reference, so a failure part-way leaves a role with no
 * binding rather than a binding pointing at a role that is gone.
 */
const DELETION_ORDER = [
  'RoleBinding',
  'ClusterRoleBinding',
  'Role',
  'ClusterRole',
  'Secret',
];

export function orderForDeletion(orphans: Orphan[]): Orphan[] {
  return [...orphans].sort(
    (a, b) => DELETION_ORDER.indexOf(a.kind) - DELETION_ORDER.indexOf(b.kind),
  );
}

export async function deleteOrphans(orphans: Orphan[]): Promise<CleanupOutcome[]> {
  const outcomes: CleanupOutcome[] = [];
  for (const o of orderForDeletion(orphans)) {
    try {
      await deleteResource(o.apiVersion, o.kind, o.name, o.namespace);
      outcomes.push({ orphan: o, ok: true });
    } catch (err) {
      outcomes.push({
        orphan: o,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return outcomes;
}

export function groupByAccount(orphans: Orphan[]): Map<string, Orphan[]> {
  const grouped = new Map<string, Orphan[]>();
  for (const o of orphans) {
    const list = grouped.get(o.account);
    if (list) list.push(o);
    else grouped.set(o.account, [o]);
  }
  return grouped;
}
