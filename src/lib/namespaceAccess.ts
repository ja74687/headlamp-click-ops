import { request } from '@kinvolk/headlamp-plugin/lib/ApiProxy';
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE, normaliseRules, PURPOSE_LABEL, Rule } from './rbac';

/**
 * The inverse of Access Builder: pick a namespace, see everything that grants access to it —
 * including bindings this plugin never created. Access Builder only knows about accounts it
 * made, which is exactly the blind spot you have when auditing.
 */

export type Subject = {
  kind: string;
  name: string;
  namespace?: string;
};

export type GrantSource = 'RoleBinding' | 'ClusterRoleBinding';

export type Grant = {
  id: string;
  source: GrantSource;
  bindingName: string;
  /** Absent for a ClusterRoleBinding, which reaches every namespace at once. */
  bindingNamespace?: string;
  roleKind: 'Role' | 'ClusterRole';
  roleName: string;
  subjects: Subject[];
  rules: Rule[];
  /** Created by this plugin. */
  managed: boolean;
  /** Part of the cluster-read bundle rather than a real workload grant. */
  uiHelper: boolean;
  /** The role could not be read, so `rules` is empty for lack of access, not lack of rules. */
  rulesUnavailable: boolean;
};

export type NamespaceAccessReport = {
  namespace: string;
  grants: Grant[];
  errors: string[];
};

type AnyObject = { metadata: any; [k: string]: any };

async function listOrThrow(url: string): Promise<AnyObject[]> {
  const res: any = await request(url);
  return (res?.items as AnyObject[]) ?? [];
}

function normaliseSubjects(raw: any[]): Subject[] {
  return (raw ?? []).map(s => ({
    kind: s?.kind ?? 'Unknown',
    name: s?.name ?? '',
    namespace: s?.namespace,
  }));
}

/**
 * Roles are fetched once per (kind, name) — a ClusterRole bound in ten namespaces is one
 * request, not ten.
 */
function makeRoleLoader(errors: string[]) {
  const cache = new Map<string, Promise<Rule[] | null>>();
  return function loadRules(
    kind: 'Role' | 'ClusterRole',
    name: string,
    namespace?: string,
  ): Promise<Rule[] | null> {
    const key = `${kind}/${namespace ?? ''}/${name}`;
    const existing = cache.get(key);
    if (existing) return existing;
    const url =
      kind === 'ClusterRole'
        ? `/apis/rbac.authorization.k8s.io/v1/clusterroles/${name}`
        : `/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/roles/${name}`;
    const promise = request(url)
      .then((role: any) => normaliseRules(role?.rules ?? []))
      .catch(err => {
        errors.push(`Could not read ${kind} ${name}: ${err instanceof Error ? err.message : err}`);
        return null;
      });
    cache.set(key, promise);
    return promise;
  };
}

export async function fetchNamespaceAccess(namespace: string): Promise<NamespaceAccessReport> {
  const errors: string[] = [];

  const [roleBindings, clusterRoleBindings] = await Promise.all([
    listOrThrow(
      `/apis/rbac.authorization.k8s.io/v1/namespaces/${namespace}/rolebindings`,
    ).catch(err => {
      errors.push(`Could not list RoleBindings in ${namespace}: ${String(err)}`);
      return [] as AnyObject[];
    }),
    listOrThrow('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings').catch(err => {
      errors.push(`Could not list ClusterRoleBindings: ${String(err)}`);
      return [] as AnyObject[];
    }),
  ]);

  const loadRules = makeRoleLoader(errors);

  const fromRoleBindings = roleBindings.map(async (rb): Promise<Grant> => {
    const roleKind: 'Role' | 'ClusterRole' = rb.roleRef?.kind === 'ClusterRole' ? 'ClusterRole' : 'Role';
    const roleName = rb.roleRef?.name ?? '';
    const rules = await loadRules(roleKind, roleName, namespace);
    const labels = rb.metadata?.labels ?? {};
    return {
      id: `rb/${namespace}/${rb.metadata.name}`,
      source: 'RoleBinding',
      bindingName: rb.metadata.name,
      bindingNamespace: namespace,
      roleKind,
      roleName,
      subjects: normaliseSubjects(rb.subjects),
      rules: rules ?? [],
      managed: labels[MANAGED_BY_LABEL] === MANAGED_BY_VALUE,
      uiHelper: Boolean(labels[PURPOSE_LABEL]),
      rulesUnavailable: rules === null,
    };
  });

  // A ClusterRoleBinding grants in every namespace, so all of them count here.
  const fromClusterRoleBindings = clusterRoleBindings.map(async (crb): Promise<Grant> => {
    const roleName = crb.roleRef?.name ?? '';
    const rules = await loadRules('ClusterRole', roleName);
    const labels = crb.metadata?.labels ?? {};
    return {
      id: `crb/${crb.metadata.name}`,
      source: 'ClusterRoleBinding',
      bindingName: crb.metadata.name,
      roleKind: 'ClusterRole',
      roleName,
      subjects: normaliseSubjects(crb.subjects),
      rules: rules ?? [],
      managed: labels[MANAGED_BY_LABEL] === MANAGED_BY_VALUE,
      uiHelper: Boolean(labels[PURPOSE_LABEL]),
      rulesUnavailable: rules === null,
    };
  });

  const grants = await Promise.all([...fromRoleBindings, ...fromClusterRoleBindings]);
  return { namespace, grants: grants.sort(compareGrants), errors };
}

function compareGrants(a: Grant, b: Grant): number {
  if (a.source !== b.source) return a.source === 'RoleBinding' ? -1 : 1;
  return a.bindingName.localeCompare(b.bindingName);
}

const WRITE_VERBS = new Set(['create', 'update', 'patch', 'delete', 'deletecollection', '*']);

/** Whether a set of rules can change anything, as opposed to read-only access. */
export function isWriteCapable(rules: Rule[]): boolean {
  return rules.some(r => r.verbs.some(v => WRITE_VERBS.has(v)));
}

/** Whether the rules cover everything — the shape a cluster-admin grant has. */
export function isFullAccess(rules: Rule[]): boolean {
  return rules.some(
    r =>
      r.apiGroups.includes('*') &&
      r.resources.includes('*') &&
      r.verbs.some(v => v === '*' || WRITE_VERBS.has(v)),
  );
}

export function summariseRules(rules: Rule[]): string {
  if (rules.length === 0) return 'no rules';
  if (isFullAccess(rules)) return 'full access';
  const resources = new Set<string>();
  for (const r of rules) {
    for (const res of r.resources) resources.add(res);
  }
  const list = [...resources].slice(0, 4).join(', ');
  const extra = resources.size > 4 ? ` +${resources.size - 4} more` : '';
  return `${isWriteCapable(rules) ? 'read/write' : 'read-only'} on ${list}${extra}`;
}

export function describeSubject(s: Subject): string {
  if (s.kind === 'ServiceAccount' && s.namespace) {
    return `system:serviceaccount:${s.namespace}:${s.name}`;
  }
  return `${s.kind}/${s.name}`;
}
