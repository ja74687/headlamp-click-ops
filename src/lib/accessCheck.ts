import { post } from '@kinvolk/headlamp-plugin/lib/ApiProxy';
import { Rule } from './rbac';

/**
 * Ask the API server what an account is actually allowed to do, instead of reasoning about
 * it from the manifests. RBAC has enough traps — a RoleBinding granting nothing
 * cluster-scoped being the one that bites hardest — that reading the rules back is not the
 * same as knowing they work.
 */

export type ResourceAttributes = {
  verb: string;
  group: string;
  resource: string;
  subresource?: string;
  namespace?: string;
};

export type AccessCheck = {
  id: string;
  label: string;
  /** What stops working when this check fails. */
  enables: string;
  attrs: ResourceAttributes;
  /** A failure here is expected at lower access levels, not a misconfiguration. */
  optional?: boolean;
};

export type AccessCheckResult = AccessCheck & {
  allowed: boolean | null;
  reason?: string;
};

const SAR_URL = '/apis/authorization.k8s.io/v1/subjectaccessreviews';

export function serviceAccountUser(namespace: string, name: string): string {
  return `system:serviceaccount:${namespace}:${name}`;
}

/**
 * The groups every ServiceAccount token authenticates with. A review that names only the
 * user ignores grants made to these groups, and reports "denied" for things the account
 * can in fact do.
 */
export function serviceAccountGroups(namespace: string): string[] {
  return ['system:serviceaccounts', `system:serviceaccounts:${namespace}`, 'system:authenticated'];
}

export type CheckTarget = {
  namespace: string;
  name: string;
  /** Namespaces the account is bound to; the first few get a per-namespace check. */
  boundNamespaces: string[];
  scope: 'Namespaced' | 'Cluster';
  /** The account's own rules; the per-namespace check asks for something they grant. */
  rules?: Rule[];
};

const MAX_NAMESPACE_CHECKS = 3;

/**
 * One permission taken straight from the account's first rule. Checking "list pods" for
 * everyone flagged an account meant only for ConfigMaps as unable to use Headlamp. Wildcards
 * are passed through as-is: RBAC matches a requested `*` only against a rule's own `*`.
 */
export function representativeAttrs(rules: Rule[] | undefined): Omit<ResourceAttributes, 'namespace'> {
  const rule = (rules ?? []).find(
    r => r.apiGroups.length > 0 && r.resources.length > 0 && r.verbs.length > 0,
  );
  if (!rule) return { verb: 'list', group: '', resource: 'pods' };
  const verb = rule.verbs.includes('list') ? 'list' : rule.verbs[0];
  const [resource, subresource] = rule.resources[0].split('/', 2);
  return {
    verb,
    group: rule.apiGroups[0],
    resource,
    ...(subresource ? { subresource } : {}),
  };
}

export function buildChecks(target: CheckTarget): AccessCheck[] {
  const checks: AccessCheck[] = [
    {
      id: 'namespaces',
      label: 'list namespaces (cluster-wide)',
      enables: "Headlamp's namespace picker and navigation",
      attrs: { verb: 'list', group: '', resource: 'namespaces' },
    },
    {
      id: 'nodes',
      label: 'list nodes (cluster-wide)',
      enables: 'the node list and the cluster overview',
      attrs: { verb: 'list', group: '', resource: 'nodes' },
      optional: true,
    },
    {
      id: 'nodemetrics',
      label: 'list nodes in metrics.k8s.io',
      enables: 'cluster CPU and memory usage',
      attrs: { verb: 'list', group: 'metrics.k8s.io', resource: 'nodes' },
      optional: true,
    },
    {
      id: 'podmetrics',
      label: 'list pods in metrics.k8s.io',
      enables: 'the top pods by CPU and memory panels',
      attrs: { verb: 'list', group: 'metrics.k8s.io', resource: 'pods' },
      optional: true,
    },
    {
      id: 'pods',
      label: 'list pods (cluster-wide)',
      enables: "the Overview pod count — without it that tile spins forever",
      attrs: { verb: 'list', group: '', resource: 'pods' },
      optional: true,
    },
    {
      id: 'pvcs',
      label: 'list persistentvolumeclaims (cluster-wide)',
      enables: 'the PersistentVolumeClaims panel in Cluster Monitor',
      attrs: { verb: 'list', group: '', resource: 'persistentvolumeclaims' },
      optional: true,
    },
    {
      id: 'nodeproxy',
      label: 'get nodes/proxy',
      enables: 'disk and volume usage read from the kubelet',
      attrs: { verb: 'get', group: '', resource: 'nodes', subresource: 'proxy' },
      optional: true,
    },
  ];

  if (target.scope === 'Namespaced') {
    const attrs = representativeAttrs(target.rules);
    const what = `${attrs.verb} ${attrs.resource}${attrs.subresource ? `/${attrs.subresource}` : ''}`;
    for (const ns of target.boundNamespaces.slice(0, MAX_NAMESPACE_CHECKS)) {
      checks.push({
        id: `work-in-${ns}`,
        label: `${what} in ${ns}`,
        enables: `the account's actual work in ${ns}`,
        attrs: { ...attrs, namespace: ns },
      });
    }
  }

  return checks;
}

async function runOne(
  user: string,
  groups: string[],
  check: AccessCheck,
): Promise<AccessCheckResult> {
  try {
    const body = {
      apiVersion: 'authorization.k8s.io/v1',
      kind: 'SubjectAccessReview',
      spec: {
        user,
        groups,
        resourceAttributes: {
          verb: check.attrs.verb,
          group: check.attrs.group,
          resource: check.attrs.resource,
          ...(check.attrs.subresource ? { subresource: check.attrs.subresource } : {}),
          ...(check.attrs.namespace ? { namespace: check.attrs.namespace } : {}),
        },
      },
    };
    const res: any = await post(SAR_URL, body, false);
    return {
      ...check,
      allowed: res?.status?.allowed === true,
      reason: res?.status?.reason,
    };
  } catch (err) {
    // `allowed: null` means "could not determine", which is not the same as "denied".
    return {
      ...check,
      allowed: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export type AccessCheckReport = {
  results: AccessCheckResult[];
  /** Set when SubjectAccessReview itself is unavailable, so no result is meaningful. */
  error: string | null;
};

export async function runAccessChecks(target: CheckTarget): Promise<AccessCheckReport> {
  const user = serviceAccountUser(target.namespace, target.name);
  const groups = serviceAccountGroups(target.namespace);
  const checks = buildChecks(target);
  const results = await Promise.all(checks.map(c => runOne(user, groups, c)));

  // Creating a SubjectAccessReview needs permission of its own. If every single check failed
  // to run, it is this account's reviewer access that is missing, not the account's.
  const allUndetermined = results.every(r => r.allowed === null);
  return {
    results,
    error: allUndetermined
      ? (results[0]?.reason ??
        'SubjectAccessReview is unavailable — you need create on authorization.k8s.io/subjectaccessreviews to run these checks.')
      : null,
  };
}

/** The one check whose failure means the account cannot use Headlamp at all. */
export function isBlocking(result: AccessCheckResult): boolean {
  return !result.optional && result.allowed === false;
}
