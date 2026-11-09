import { request } from '@kinvolk/headlamp-plugin/lib/ApiProxy';
import {
  levelFromUiAccessRules,
  MANAGED_BY_LABEL,
  MANAGED_BY_VALUE,
  normaliseRules,
  PURPOSE_LABEL,
  PURPOSE_UI_CLUSTER_READ,
  Rule,
  UiAccessLevel,
} from './rbac';

const LABEL_SELECTOR = `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`;

/** Flip to true when debugging discovery; it logs every binding and rule it walks. */
const DEBUG = false;

function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  // eslint-disable-next-line no-console
  console.log('[access-builder]', ...args);
}

function warn(...args: unknown[]): void {
  // eslint-disable-next-line no-console
  console.warn('[access-builder]', ...args);
}

/** One RoleBinding, keeping namespace and name paired — they must never drift apart. */
export type BindingRef = {
  namespace: string;
  name: string;
};

export type ManagedAccount = {
  name: string;
  namespace: string;
  scope: 'Namespaced' | 'Cluster';
  roleKind: 'Role' | 'ClusterRole';
  roleName: string;
  tokenSecretName: string;
  clusterReadName: string;
  uiAccess: UiAccessLevel;
  bindings: BindingRef[];
  /** Derived from `bindings`, for display only. */
  bindingNamespaces: string[];
  clusterBindingName?: string;
  rules: Rule[];
};

export type AnyObject = { metadata: any; [k: string]: any };

/** Objects carrying this plugin's managed-by label. A failed list comes back as `error`. */
export async function listManagedObjects(
  url: string,
): Promise<{ items: AnyObject[]; error: string | null }> {
  try {
    const res: any = await request(`${url}?labelSelector=${encodeURIComponent(LABEL_SELECTOR)}`);
    return { items: (res?.items as AnyObject[]) ?? [], error: null };
  } catch (err) {
    return { items: [], error: `${url}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function listAll(url: string): Promise<AnyObject[]> {
  try {
    const res: any = await request(url);
    return (res?.items as AnyObject[]) ?? [];
  } catch (err) {
    warn('listAll failed', url, err);
    return [];
  }
}

async function getOne(url: string): Promise<AnyObject | null> {
  try {
    return (await request(url)) as AnyObject;
  } catch {
    return null;
  }
}

function isUiClusterRead(obj: AnyObject): boolean {
  return obj?.metadata?.labels?.[PURPOSE_LABEL] === PURPOSE_UI_CLUSTER_READ;
}

/**
 * Whether a (Cluster)RoleBinding is this account's: by subject first, then by the
 * `access-builder/account` label, then by the `<sa>-binding[-<ns>]` name.
 */
export function bindingBelongsTo(obj: AnyObject, saName: string, saNamespace: string): boolean {
  if (Array.isArray(obj.subjects)) {
    const sameName = obj.subjects.filter(
      (s: any) => s?.kind === 'ServiceAccount' && s.name === saName,
    );
    if (sameName.some((s: any) => s.namespace === saNamespace)) return true;
    // The label and name fallbacks below carry no namespace. A binding whose subject is a
    // same-named account in another namespace belongs to that account; claiming it here
    // let an edit of one account prune the other's bindings.
    if (sameName.length > 0) return false;
  }
  const labels = obj.metadata?.labels ?? {};
  if (labels['access-builder/account'] === saName) return true;
  const prefix = `${saName}-binding`;
  const n: string = obj.metadata?.name ?? '';
  return n === prefix || n.startsWith(`${prefix}-`);
}

export async function listManagedAccounts(): Promise<ManagedAccount[]> {
  const [saList, roleBindingsRaw, clusterRoleBindingsRaw] = await Promise.all([
    listManagedObjects('/api/v1/serviceaccounts'),
    listAll('/apis/rbac.authorization.k8s.io/v1/rolebindings'),
    listAll('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings'),
  ]);
  // An empty list here would read as "no accounts yet", which is not what happened.
  if (saList.error) throw new Error(`Could not list ServiceAccounts — ${saList.error}`);
  const serviceAccounts = saList.items;

  // The cluster-read bundle names the SA as a subject, so it would otherwise be picked up
  // as the account's own binding and flip its scope to Cluster.
  const roleBindings = roleBindingsRaw.filter(rb => !isUiClusterRead(rb));
  const clusterRoleBindings = clusterRoleBindingsRaw.filter(crb => !isUiClusterRead(crb));

  const accounts: ManagedAccount[] = [];

  for (const sa of serviceAccounts) {
    const saName: string = sa.metadata.name;
    const saNamespace: string = sa.metadata.namespace;
    const bindingNamePrefix = `${saName}-binding`;
    const clusterReadName = `${saName}-cluster-read`;

    const matchesAccount = (obj: AnyObject) => bindingBelongsTo(obj, saName, saNamespace);

    let matchedRBs = roleBindings.filter(matchesAccount);
    let matchedCRB = clusterRoleBindings.find(matchesAccount);

    if (matchedRBs.length === 0 && !matchedCRB) {
      const directRB = await getOne(
        `/apis/rbac.authorization.k8s.io/v1/namespaces/${saNamespace}/rolebindings/${bindingNamePrefix}`,
      );
      // Same ownership test as the list: by name alone these could be a same-named
      // account's in another namespace.
      if (directRB && matchesAccount(directRB)) matchedRBs = [directRB];
      if (matchedRBs.length === 0) {
        const directCRB = await getOne(
          `/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${bindingNamePrefix}`,
        );
        if (directCRB && matchesAccount(directCRB)) matchedCRB = directCRB;
      }
    }

    debug('per-account', {
      sa: `${saNamespace}/${saName}`,
      matchedRBs: matchedRBs.map(rb => `${rb.metadata.namespace}/${rb.metadata.name}`),
      matchedCRB: matchedCRB?.metadata?.name ?? null,
    });

    let roleKind: 'Role' | 'ClusterRole' = 'Role';
    let roleName = `${saName}-role`;
    let rules: Rule[] = [];

    if (matchedCRB) {
      roleKind = 'ClusterRole';
      roleName = matchedCRB.roleRef?.name ?? roleName;
      const role = await getOne(`/apis/rbac.authorization.k8s.io/v1/clusterroles/${roleName}`);
      rules = normaliseRules(role?.rules ?? []);
    } else if (matchedRBs.length > 0) {
      const first = matchedRBs[0];
      roleKind = first.roleRef?.kind ?? 'Role';
      roleName = first.roleRef?.name ?? roleName;
      if (roleKind === 'ClusterRole') {
        const role = await getOne(`/apis/rbac.authorization.k8s.io/v1/clusterroles/${roleName}`);
        rules = normaliseRules(role?.rules ?? []);
      } else {
        const ns = first.metadata.namespace;
        const role = await getOne(
          `/apis/rbac.authorization.k8s.io/v1/namespaces/${ns}/roles/${roleName}`,
        );
        rules = normaliseRules(role?.rules ?? []);
      }
    }

    // Sort namespace and name together. Sorting them as two independent arrays used to
    // pair binding[i] with the wrong namespace, so pruning deleted a non-existent name
    // (silently swallowed as 404) and left the real binding — and its access — behind.
    const bindings: BindingRef[] = matchedRBs
      .map(rb => ({ namespace: rb.metadata.namespace as string, name: rb.metadata.name as string }))
      .sort((a, b) => a.namespace.localeCompare(b.namespace));

    const clusterReadRole = await getOne(
      `/apis/rbac.authorization.k8s.io/v1/clusterroles/${clusterReadName}`,
    );

    accounts.push({
      name: saName,
      namespace: saNamespace,
      scope: matchedCRB ? 'Cluster' : 'Namespaced',
      roleKind,
      roleName,
      tokenSecretName: `${saName}-token`,
      clusterReadName,
      uiAccess: clusterReadRole
        ? levelFromUiAccessRules(normaliseRules(clusterReadRole.rules ?? []))
        : 'none',
      bindings,
      bindingNamespaces: bindings.map(b => b.namespace),
      clusterBindingName: matchedCRB?.metadata?.name,
      rules,
    });
  }

  const sorted = accounts.sort((a, b) => a.name.localeCompare(b.name));
  debug('discovery summary', {
    serviceAccountsFound: serviceAccounts.length,
    accounts: sorted.map(a => ({
      name: a.name,
      ns: a.namespace,
      scope: a.scope,
      roleKind: a.roleKind,
      boundNamespaces: a.bindingNamespaces,
      uiAccess: a.uiAccess,
      ruleCount: a.rules.length,
    })),
  });
  return sorted;
}
