import { Verb } from './catalog';

export const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
export const MANAGED_BY_VALUE = 'headlamp-access-builder';

/**
 * Marks the extra cluster-read bundle. Discovery must skip anything carrying it, otherwise
 * the ClusterRoleBinding (which lists the SA as a subject) would be mistaken for the
 * account's own binding and the account would show up as cluster-wide.
 */
export const PURPOSE_LABEL = 'access-builder/purpose';
export const PURPOSE_UI_CLUSTER_READ = 'ui-cluster-read';

export type Rule = {
  apiGroups: string[];
  resources: string[];
  verbs: Verb[];
};

/**
 * How much cluster-scoped read access to grant on top of the namespaced bindings.
 *
 * A RoleBinding only ever grants inside its own namespace, even when it points at a
 * ClusterRole. Anything cluster-scoped — listing namespaces, reading nodes, metrics —
 * therefore needs a real ClusterRoleBinding, or the account cannot use the Headlamp UI
 * at all ("namespaces is forbidden ... at the cluster scope"). Levels are cumulative.
 */
export type UiAccessLevel = 'none' | 'namespaces' | 'metrics' | 'kubelet';

export const UI_ACCESS_LEVELS: {
  value: UiAccessLevel;
  label: string;
  description: string;
  danger?: boolean;
}[] = [
  {
    value: 'none',
    label: 'None',
    description:
      'Namespaced access only. Headlamp will show "namespaces is forbidden" and the cluster overview stays empty.',
  },
  {
    value: 'namespaces',
    label: 'Namespace list (recommended)',
    description:
      'get/list/watch on namespaces cluster-wide. The minimum for Headlamp to render its namespace picker. Reveals namespace names only.',
  },
  {
    value: 'metrics',
    label: '+ nodes and metrics',
    description:
      'Adds nodes and metrics.k8s.io so the cluster CPU/memory overview works. Pod metrics are cluster-wide, so pod names from other namespaces become visible.',
  },
  {
    value: 'kubelet',
    label: '+ kubelet stats (disk usage)',
    description:
      'Adds get on nodes/proxy for the disk and PVC usage panels. This grants access to the kubelet API, through which logs and metadata of every pod on a node can be read — a genuine privilege escalation.',
    danger: true,
  },
];

export type BuildInput = {
  scope: 'Namespaced' | 'Cluster';
  namespaces: string[];
  tokenNamespace: string;
  serviceAccountName: string;
  roleName: string;
  bindingNamePrefix: string;
  tokenSecretName: string;
  clusterReadName: string;
  uiAccess: UiAccessLevel;
  rules: Rule[];
};

const managedLabels = { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE };

export function roleKind(input: BuildInput): 'Role' | 'ClusterRole' {
  if (input.scope === 'Cluster') return 'ClusterRole';
  if (input.namespaces.length > 1) return 'ClusterRole';
  return 'Role';
}

export function bindingName(prefix: string, namespace?: string): string {
  if (namespace) return `${prefix}-${namespace}`;
  return prefix;
}

export function buildServiceAccount(input: BuildInput) {
  return {
    apiVersion: 'v1',
    kind: 'ServiceAccount',
    metadata: {
      name: input.serviceAccountName,
      namespace: input.tokenNamespace,
      labels: { ...managedLabels, 'access-builder/account': input.serviceAccountName },
    },
  };
}

export function buildTokenSecret(input: BuildInput) {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: input.tokenSecretName,
      namespace: input.tokenNamespace,
      annotations: {
        'kubernetes.io/service-account.name': input.serviceAccountName,
      },
      labels: { ...managedLabels, 'access-builder/account': input.serviceAccountName },
    },
    type: 'kubernetes.io/service-account-token',
  };
}

export function buildRole(input: BuildInput) {
  const kind = roleKind(input);
  if (kind === 'ClusterRole') {
    return {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: {
        name: input.roleName,
        labels: { ...managedLabels, 'access-builder/account': input.serviceAccountName },
      },
      rules: input.rules,
    };
  }
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'Role',
    metadata: {
      name: input.roleName,
      namespace: input.namespaces[0],
      labels: { ...managedLabels, 'access-builder/account': input.serviceAccountName },
    },
    rules: input.rules,
  };
}

export function buildBindings(input: BuildInput) {
  const subject = {
    kind: 'ServiceAccount',
    name: input.serviceAccountName,
    namespace: input.tokenNamespace,
  };
  const kind = roleKind(input);
  const roleRef = {
    apiGroup: 'rbac.authorization.k8s.io',
    kind,
    name: input.roleName,
  };

  if (input.scope === 'Cluster') {
    return [
      {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'ClusterRoleBinding',
        metadata: {
          name: bindingName(input.bindingNamePrefix),
          labels: {
            ...managedLabels,
            'access-builder/account': input.serviceAccountName,
          },
        },
        subjects: [subject],
        roleRef,
      },
    ];
  }

  return input.namespaces.map(ns => ({
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind: 'RoleBinding',
    metadata: {
      name: bindingName(input.bindingNamePrefix, ns),
      namespace: ns,
      labels: {
        ...managedLabels,
        'access-builder/account': input.serviceAccountName,
        'access-builder/binding-namespace': ns,
      },
    },
    subjects: [subject],
    roleRef,
  }));
}

export function uiAccessRules(level: UiAccessLevel): Rule[] {
  if (level === 'none') return [];
  const rules: Rule[] = [
    { apiGroups: [''], resources: ['namespaces'], verbs: ['get', 'list', 'watch'] },
  ];
  if (level === 'metrics' || level === 'kubelet') {
    rules.push({ apiGroups: [''], resources: ['nodes'], verbs: ['get', 'list', 'watch'] });
    rules.push({
      apiGroups: ['metrics.k8s.io'],
      resources: ['nodes', 'pods'],
      verbs: ['get', 'list'],
    });
  }
  if (level === 'kubelet') {
    rules.push({ apiGroups: [''], resources: ['nodes/proxy'], verbs: ['get'] });
  }
  return rules;
}

export function levelFromUiAccessRules(rules: Rule[]): UiAccessLevel {
  if (!rules || rules.length === 0) return 'none';
  const has = (group: string, resource: string) =>
    rules.some(r => r.apiGroups.includes(group) && r.resources.includes(resource));
  if (has('', 'nodes/proxy')) return 'kubelet';
  if (has('metrics.k8s.io', 'nodes') || has('', 'nodes')) return 'metrics';
  if (has('', 'namespaces')) return 'namespaces';
  return 'none';
}

/**
 * The extra cluster-scoped read bundle. Deliberately does NOT carry the
 * `access-builder/account` label — see PURPOSE_LABEL.
 */
export function buildUiClusterRead(input: BuildInput) {
  const rules = uiAccessRules(input.uiAccess);
  if (rules.length === 0) return [];
  const labels = {
    ...managedLabels,
    [PURPOSE_LABEL]: PURPOSE_UI_CLUSTER_READ,
    'access-builder/for-account': input.serviceAccountName,
  };
  return [
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRole',
      metadata: { name: input.clusterReadName, labels },
      rules,
    },
    {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: { name: input.clusterReadName, labels },
      subjects: [
        {
          kind: 'ServiceAccount',
          name: input.serviceAccountName,
          namespace: input.tokenNamespace,
        },
      ],
      roleRef: {
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'ClusterRole',
        name: input.clusterReadName,
      },
    },
  ];
}

export function buildAll(input: BuildInput) {
  return [
    buildServiceAccount(input),
    buildTokenSecret(input),
    buildRole(input),
    ...buildBindings(input),
    ...buildUiClusterRead(input),
  ];
}

/** Kubernetes object names are DNS subdomains: lowercase, max 253 chars. */
export function sanitizeName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  // Leave room for the longest suffix we append (`-cluster-read`).
  return cleaned.slice(0, 240).replace(/-$/, '') || 'access';
}

export function deriveNames(serviceAccountName: string) {
  const base = sanitizeName(serviceAccountName);
  return {
    serviceAccountName: base,
    roleName: `${base}-role`,
    bindingNamePrefix: `${base}-binding`,
    tokenSecretName: `${base}-token`,
    clusterReadName: `${base}-cluster-read`,
  };
}

export function validateInput(input: BuildInput): string[] {
  const errors: string[] = [];
  if (!input.serviceAccountName) errors.push('ServiceAccount name is required.');
  if (!input.tokenNamespace) errors.push('Namespace for the token Secret is required.');
  if (input.scope === 'Namespaced' && input.namespaces.length === 0) {
    errors.push('Pick at least one namespace.');
  }
  if (input.rules.length === 0) errors.push('At least one rule is required.');
  for (const [i, rule] of input.rules.entries()) {
    if (rule.verbs.length === 0) errors.push(`Rule ${i + 1}: pick at least one verb.`);
    if (rule.resources.length === 0) errors.push(`Rule ${i + 1}: pick at least one resource.`);
  }
  return errors;
}
