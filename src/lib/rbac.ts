import { Verb } from './catalog';

export const MANAGED_BY_LABEL = 'app.kubernetes.io/managed-by';
export const MANAGED_BY_VALUE = 'headlamp-access-builder';

export type Rule = {
  apiGroups: string[];
  resources: string[];
  verbs: Verb[];
};

export type BuildInput = {
  scope: 'Namespaced' | 'Cluster';
  namespaces: string[];
  tokenNamespace: string;
  serviceAccountName: string;
  roleName: string;
  bindingNamePrefix: string;
  tokenSecretName: string;
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

export function buildAll(input: BuildInput) {
  return [
    buildServiceAccount(input),
    buildTokenSecret(input),
    buildRole(input),
    ...buildBindings(input),
  ];
}

export function sanitizeName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || 'access';
}

export function deriveNames(serviceAccountName: string) {
  const base = sanitizeName(serviceAccountName);
  return {
    serviceAccountName: base,
    roleName: `${base}-role`,
    bindingNamePrefix: `${base}-binding`,
    tokenSecretName: `${base}-token`,
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
