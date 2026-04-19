import { request } from '@kinvolk/headlamp-plugin/lib/ApiProxy';
import { Verb } from './catalog';
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE, Rule } from './rbac';

const LABEL_SELECTOR = `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`;

export type ManagedAccount = {
  name: string;
  namespace: string;
  scope: 'Namespaced' | 'Cluster';
  roleKind: 'Role' | 'ClusterRole';
  roleName: string;
  tokenSecretName: string;
  bindingNamespaces: string[];
  bindingNames: string[];
  clusterBindingName?: string;
  rules: Rule[];
};

type AnyObject = { metadata: any; [k: string]: any };

async function listManaged(url: string): Promise<AnyObject[]> {
  try {
    const res: any = await request(`${url}?labelSelector=${encodeURIComponent(LABEL_SELECTOR)}`);
    return (res?.items as AnyObject[]) ?? [];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[access-builder] listManaged failed', url, err);
    return [];
  }
}

async function listAll(url: string): Promise<AnyObject[]> {
  try {
    const res: any = await request(url);
    return (res?.items as AnyObject[]) ?? [];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[access-builder] listAll failed', url, err);
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

export async function listManagedAccounts(): Promise<ManagedAccount[]> {
  const [serviceAccounts, roleBindings, clusterRoleBindings] = await Promise.all([
    listManaged('/api/v1/serviceaccounts'),
    listAll('/apis/rbac.authorization.k8s.io/v1/rolebindings'),
    listAll('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings'),
  ]);

  const accounts: ManagedAccount[] = [];

  for (const sa of serviceAccounts) {
    const saName: string = sa.metadata.name;
    const saNamespace: string = sa.metadata.namespace;
    const bindingNamePrefix = `${saName}-binding`;

    const matchesAccount = (obj: AnyObject): boolean => {
      if (Array.isArray(obj.subjects)) {
        if (
          obj.subjects.some(
            (s: any) =>
              s?.kind === 'ServiceAccount' && s.name === saName && s.namespace === saNamespace,
          )
        ) {
          return true;
        }
      }
      const labels = obj.metadata?.labels ?? {};
      if (labels['access-builder/account'] === saName) return true;
      const n: string = obj.metadata?.name ?? '';
      if (n === bindingNamePrefix || n.startsWith(`${bindingNamePrefix}-`)) return true;
      return false;
    };

    let matchedRBs = roleBindings.filter(matchesAccount);
    let matchedCRB = clusterRoleBindings.find(matchesAccount);

    if (matchedRBs.length === 0 && !matchedCRB) {
      const directRB = await getOne(
        `/apis/rbac.authorization.k8s.io/v1/namespaces/${saNamespace}/rolebindings/${bindingNamePrefix}`,
      );
      if (directRB) matchedRBs = [directRB];
      if (!directRB) {
        const directCRB = await getOne(
          `/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${bindingNamePrefix}`,
        );
        if (directCRB) matchedCRB = directCRB;
      }
    }

    // eslint-disable-next-line no-console
    console.log('[access-builder] per-account', {
      sa: `${saNamespace}/${saName}`,
      matchedRBs: matchedRBs.map(rb => ({
        name: `${rb.metadata.namespace}/${rb.metadata.name}`,
        subjects: rb.subjects,
      })),
      matchedCRB: matchedCRB
        ? { name: matchedCRB.metadata.name, subjects: matchedCRB.subjects }
        : null,
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

    accounts.push({
      name: saName,
      namespace: saNamespace,
      scope: matchedCRB ? 'Cluster' : 'Namespaced',
      roleKind,
      roleName,
      tokenSecretName: `${saName}-token`,
      bindingNamespaces: matchedRBs.map(rb => rb.metadata.namespace).sort(),
      bindingNames: matchedRBs.map(rb => rb.metadata.name),
      clusterBindingName: matchedCRB?.metadata?.name,
      rules,
    });
  }

  const sorted = accounts.sort((a, b) => a.name.localeCompare(b.name));
  // eslint-disable-next-line no-console
  console.log('[access-builder] discovery summary', {
    serviceAccountsFound: serviceAccounts.length,
    roleBindingsFound: roleBindings.length,
    clusterRoleBindingsFound: clusterRoleBindings.length,
    accounts: sorted.map(a => ({
      name: a.name,
      ns: a.namespace,
      scope: a.scope,
      roleKind: a.roleKind,
      boundNamespaces: a.bindingNamespaces,
      ruleCount: a.rules.length,
    })),
  });
  return sorted;
}

function normaliseRules(raw: any[]): Rule[] {
  return (raw ?? []).map(r => ({
    apiGroups: Array.isArray(r.apiGroups) ? r.apiGroups : [''],
    resources: Array.isArray(r.resources) ? r.resources : [],
    verbs: Array.isArray(r.verbs) ? (r.verbs as Verb[]) : [],
  }));
}
