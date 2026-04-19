export type ApiResource = {
  group: string;
  resource: string;
  label: string;
  scope: 'Namespaced' | 'Cluster';
};

export const VERBS = [
  'get',
  'list',
  'watch',
  'create',
  'update',
  'patch',
  'delete',
  'deletecollection',
] as const;

export type Verb = (typeof VERBS)[number];

export const RESOURCE_CATALOG: ApiResource[] = [
  { group: '', resource: 'pods', label: 'Pods', scope: 'Namespaced' },
  { group: '', resource: 'pods/log', label: 'Pod logs', scope: 'Namespaced' },
  { group: '', resource: 'pods/exec', label: 'Pod exec', scope: 'Namespaced' },
  { group: '', resource: 'pods/portforward', label: 'Pod port-forward', scope: 'Namespaced' },
  { group: '', resource: 'services', label: 'Services', scope: 'Namespaced' },
  { group: '', resource: 'endpoints', label: 'Endpoints', scope: 'Namespaced' },
  { group: '', resource: 'configmaps', label: 'ConfigMaps', scope: 'Namespaced' },
  { group: '', resource: 'secrets', label: 'Secrets', scope: 'Namespaced' },
  {
    group: '',
    resource: 'persistentvolumeclaims',
    label: 'PersistentVolumeClaims',
    scope: 'Namespaced',
  },
  { group: '', resource: 'events', label: 'Events', scope: 'Namespaced' },
  { group: '', resource: 'serviceaccounts', label: 'ServiceAccounts', scope: 'Namespaced' },
  { group: '', resource: 'namespaces', label: 'Namespaces', scope: 'Cluster' },
  { group: '', resource: 'nodes', label: 'Nodes', scope: 'Cluster' },
  { group: '', resource: 'persistentvolumes', label: 'PersistentVolumes', scope: 'Cluster' },
  { group: 'apps', resource: 'deployments', label: 'Deployments', scope: 'Namespaced' },
  { group: 'apps', resource: 'statefulsets', label: 'StatefulSets', scope: 'Namespaced' },
  { group: 'apps', resource: 'daemonsets', label: 'DaemonSets', scope: 'Namespaced' },
  { group: 'apps', resource: 'replicasets', label: 'ReplicaSets', scope: 'Namespaced' },
  { group: 'batch', resource: 'jobs', label: 'Jobs', scope: 'Namespaced' },
  { group: 'batch', resource: 'cronjobs', label: 'CronJobs', scope: 'Namespaced' },
  { group: 'networking.k8s.io', resource: 'ingresses', label: 'Ingresses', scope: 'Namespaced' },
  {
    group: 'networking.k8s.io',
    resource: 'networkpolicies',
    label: 'NetworkPolicies',
    scope: 'Namespaced',
  },
  { group: 'networking.k8s.io', resource: 'ingressclasses', label: 'IngressClasses', scope: 'Cluster' },
  { group: 'storage.k8s.io', resource: 'storageclasses', label: 'StorageClasses', scope: 'Cluster' },
  {
    group: 'policy',
    resource: 'poddisruptionbudgets',
    label: 'PodDisruptionBudgets',
    scope: 'Namespaced',
  },
  {
    group: 'autoscaling',
    resource: 'horizontalpodautoscalers',
    label: 'HorizontalPodAutoscalers',
    scope: 'Namespaced',
  },
  {
    group: 'rbac.authorization.k8s.io',
    resource: 'roles',
    label: 'Roles',
    scope: 'Namespaced',
  },
  {
    group: 'rbac.authorization.k8s.io',
    resource: 'rolebindings',
    label: 'RoleBindings',
    scope: 'Namespaced',
  },
  {
    group: 'rbac.authorization.k8s.io',
    resource: 'clusterroles',
    label: 'ClusterRoles',
    scope: 'Cluster',
  },
  {
    group: 'rbac.authorization.k8s.io',
    resource: 'clusterrolebindings',
    label: 'ClusterRoleBindings',
    scope: 'Cluster',
  },
];

export type Preset = {
  id: string;
  label: string;
  description: string;
  scope: 'Namespaced' | 'Cluster';
  rules: { apiGroups: string[]; resources: string[]; verbs: Verb[] }[];
};

export const PRESETS: Preset[] = [
  {
    id: 'ns-viewer',
    label: 'Namespace viewer (read-only)',
    description: 'get/list/watch on the most common namespaced resources.',
    scope: 'Namespaced',
    rules: [
      {
        apiGroups: ['', 'apps', 'batch', 'networking.k8s.io', 'autoscaling', 'policy'],
        resources: ['*'],
        verbs: ['get', 'list', 'watch'],
      },
    ],
  },
  {
    id: 'ns-deployer',
    label: 'Namespace deployer',
    description: 'Full CRUD on workloads, services, configmaps, secrets.',
    scope: 'Namespaced',
    rules: [
      {
        apiGroups: ['', 'apps', 'batch', 'networking.k8s.io'],
        resources: ['*'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
    ],
  },
  {
    id: 'pod-debugger',
    label: 'Pod debugger',
    description: 'Read pods + exec/logs/port-forward. No writes on workloads.',
    scope: 'Namespaced',
    rules: [
      {
        apiGroups: [''],
        resources: ['pods', 'pods/log'],
        verbs: ['get', 'list', 'watch'],
      },
      {
        apiGroups: [''],
        resources: ['pods/exec', 'pods/portforward'],
        verbs: ['create'],
      },
    ],
  },
  {
    id: 'cluster-viewer',
    label: 'Cluster viewer (read-only, all namespaces)',
    description: 'Read everything cluster-wide.',
    scope: 'Cluster',
    rules: [
      {
        apiGroups: ['*'],
        resources: ['*'],
        verbs: ['get', 'list', 'watch'],
      },
    ],
  },
  {
    id: 'cluster-admin',
    label: 'Cluster admin (DANGEROUS)',
    description: 'Full access to everything. Equivalent to the built-in cluster-admin role.',
    scope: 'Cluster',
    rules: [
      {
        apiGroups: ['*'],
        resources: ['*'],
        verbs: ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection'],
      },
    ],
  },
];
