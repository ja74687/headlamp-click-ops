import { request } from '@kinvolk/headlamp-plugin/lib/ApiProxy';

export type NodeRow = {
  name: string;
  ready: boolean;
  cpuUsed: number | null;
  cpuCapacity: number;
  memUsedBytes: number | null;
  memCapacityBytes: number;
  rootFsUsedBytes: number | null;
  rootFsCapacityBytes: number | null;
  imageFsUsedBytes: number | null;
  imageFsCapacityBytes: number | null;
  errors: string[];
};

export type VolumeUsage = {
  usedBytes: number;
  capacityBytes: number;
};

export type ClusterMetricsResult = {
  nodes: NodeRow[];
  metricsServerError: string | null;
  volumeUsageByPvc: Map<string, VolumeUsage>;
};

export type PvcRow = {
  namespace: string;
  name: string;
  status: string;
  capacityBytes: number;
  storageClass: string;
  volumeName: string;
  ageMs: number;
};

export type PodMetricRow = {
  namespace: string;
  name: string;
  cpuCores: number;
  memoryBytes: number;
};

type KubeNode = {
  metadata: { name: string };
  status: {
    capacity?: { cpu?: string; memory?: string; 'ephemeral-storage'?: string };
    allocatable?: { cpu?: string; memory?: string };
    conditions?: { type: string; status: string }[];
  };
};

type NodeMetricsItem = {
  metadata: { name: string };
  usage: { cpu: string; memory: string };
};

type KubePodMin = {
  metadata: { name: string; namespace: string };
  spec: {
    volumes?: {
      name: string;
      persistentVolumeClaim?: { claimName: string };
    }[];
  };
};

type StatsSummary = {
  node?: {
    fs?: { availableBytes?: number; capacityBytes?: number; usedBytes?: number };
    runtime?: {
      imageFs?: { availableBytes?: number; capacityBytes?: number; usedBytes?: number };
    };
  };
  pods?: {
    podRef?: { name: string; namespace: string };
    volume?: {
      name?: string;
      pvcRef?: { name: string; namespace: string };
      usedBytes?: number;
      capacityBytes?: number;
      availableBytes?: number;
    }[];
  }[];
};

export function pvcKey(namespace: string, name: string): string {
  return `${namespace}/${name}`;
}

const SI: Record<string, number> = {
  '': 1,
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
};

const BIN: Record<string, number> = {
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
  Pi: 2 ** 50,
  Ei: 2 ** 60,
};

export function parseQuantity(q: string | undefined | null): number {
  if (q === undefined || q === null || q === '') return 0;
  const m = String(q).match(/^([+-]?[0-9.]+)([a-zA-Z]*)$/);
  if (!m) {
    const n = Number(q);
    return Number.isFinite(n) ? n : 0;
  }
  const num = parseFloat(m[1]);
  const suf = m[2];
  if (suf in BIN) return num * BIN[suf];
  if (suf in SI) return num * SI[suf];
  return num;
}

function isReady(n: KubeNode): boolean {
  return (n.status.conditions ?? []).some(c => c.type === 'Ready' && c.status === 'True');
}

export function formatBytes(b: number | null): string {
  if (b === null) return '—';
  if (b === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

export function formatCores(c: number | null): string {
  if (c === null) return '—';
  if (c < 1) return `${(c * 1000).toFixed(0)}m`;
  return `${c.toFixed(c >= 10 ? 1 : 2)}`;
}

export function pct(used: number | null, capacity: number | null): number | null {
  if (used === null || capacity === null || capacity === 0) return null;
  return Math.min(100, Math.max(0, (used / capacity) * 100));
}

async function listNodes(): Promise<KubeNode[]> {
  const res = await request('/api/v1/nodes');
  return (res.items ?? []) as KubeNode[];
}

async function listPodsForVolumeMap(): Promise<{ pods: KubePodMin[]; error: string | null }> {
  try {
    const res = await request('/api/v1/pods');
    return { pods: (res.items ?? []) as KubePodMin[], error: null };
  } catch (err) {
    return { pods: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function getNodeMetrics(): Promise<{
  byName: Map<string, NodeMetricsItem>;
  error: string | null;
}> {
  try {
    const res = await request('/apis/metrics.k8s.io/v1beta1/nodes');
    const items = (res.items ?? []) as NodeMetricsItem[];
    return { byName: new Map(items.map(i => [i.metadata.name, i])), error: null };
  } catch (err) {
    return {
      byName: new Map(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function getNodeStats(nodeName: string): Promise<StatsSummary | null> {
  try {
    return (await request(`/api/v1/nodes/${nodeName}/proxy/stats/summary`)) as StatsSummary;
  } catch {
    return null;
  }
}

export async function fetchClusterMetrics(): Promise<ClusterMetricsResult> {
  const [nodes, metricsResult, podsResult] = await Promise.all([
    listNodes(),
    getNodeMetrics(),
    listPodsForVolumeMap(),
  ]);
  const stats = await Promise.all(
    nodes.map(n => getNodeStats(n.metadata.name).then(s => [n.metadata.name, s] as const)),
  );
  const statsByName = new Map(stats);

  const podVolumeToPvc = new Map<string, Map<string, { namespace: string; name: string }>>();
  for (const pod of podsResult.pods) {
    const volMap = new Map<string, { namespace: string; name: string }>();
    for (const vol of pod.spec.volumes ?? []) {
      const claim = vol.persistentVolumeClaim?.claimName;
      if (claim && vol.name) {
        volMap.set(vol.name, { namespace: pod.metadata.namespace, name: claim });
      }
    }
    if (volMap.size > 0) {
      podVolumeToPvc.set(`${pod.metadata.namespace}/${pod.metadata.name}`, volMap);
    }
  }
  const rows: NodeRow[] = nodes.map(n => {
    const errors: string[] = [];
    const cap = n.status.capacity ?? {};
    const cpuCapacity = parseQuantity(cap.cpu);
    const memCapacityBytes = parseQuantity(cap.memory);

    const m = metricsResult.byName.get(n.metadata.name);
    const cpuUsed = m ? parseQuantity(m.usage.cpu) : null;
    const memUsedBytes = m ? parseQuantity(m.usage.memory) : null;
    if (!m && !metricsResult.error) errors.push('No metrics for node');

    const s = statsByName.get(n.metadata.name) ?? null;
    const rootFs = s?.node?.fs;
    const imageFs = s?.node?.runtime?.imageFs;
    if (!s) errors.push('No disk stats (kubelet proxy unavailable)');

    return {
      name: n.metadata.name,
      ready: isReady(n),
      cpuUsed,
      cpuCapacity,
      memUsedBytes,
      memCapacityBytes,
      rootFsUsedBytes: rootFs?.usedBytes ?? null,
      rootFsCapacityBytes: rootFs?.capacityBytes ?? null,
      imageFsUsedBytes: imageFs?.usedBytes ?? null,
      imageFsCapacityBytes: imageFs?.capacityBytes ?? null,
      errors,
    };
  });

  const volumeUsageByPvc = new Map<string, VolumeUsage>();
  for (const [, summary] of statsByName) {
    const podsArr = summary?.pods ?? [];
    for (const pod of podsArr) {
      const podKey = pod.podRef ? `${pod.podRef.namespace}/${pod.podRef.name}` : '';
      const fallbackVolMap = podKey ? podVolumeToPvc.get(podKey) : undefined;
      for (const vol of pod.volume ?? []) {
        let ref = vol.pvcRef;
        if (!ref && fallbackVolMap && vol.name) {
          ref = fallbackVolMap.get(vol.name);
        }
        if (!ref) continue;
        const used = vol.usedBytes ?? 0;
        const capacity = vol.capacityBytes ?? 0;
        const key = pvcKey(ref.namespace, ref.name);
        const prev = volumeUsageByPvc.get(key);
        if (!prev || used > prev.usedBytes) {
          volumeUsageByPvc.set(key, { usedBytes: used, capacityBytes: capacity });
        }
      }
    }
  }

  return {
    nodes: rows,
    metricsServerError: metricsResult.error,
    volumeUsageByPvc,
  };
}

export function sumNullable(values: (number | null)[]): number | null {
  let sum = 0;
  let any = false;
  for (const v of values) {
    if (v !== null) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

export function sumNumbers(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

type KubePvc = {
  metadata: { name: string; namespace: string; creationTimestamp?: string };
  spec: { storageClassName?: string; volumeName?: string };
  status: { phase?: string; capacity?: { storage?: string } };
};

type PodMetricsItem = {
  metadata: { name: string; namespace: string };
  containers: { name: string; usage: { cpu: string; memory: string } }[];
};

export async function fetchPvcs(): Promise<PvcRow[]> {
  const res = await request('/api/v1/persistentvolumeclaims');
  const items = (res.items ?? []) as KubePvc[];
  const now = Date.now();
  return items
    .map(p => {
      const created = p.metadata.creationTimestamp
        ? new Date(p.metadata.creationTimestamp).getTime()
        : now;
      return {
        namespace: p.metadata.namespace,
        name: p.metadata.name,
        status: p.status.phase ?? 'Unknown',
        capacityBytes: parseQuantity(p.status.capacity?.storage),
        storageClass: p.spec.storageClassName ?? '—',
        volumeName: p.spec.volumeName ?? '',
        ageMs: now - created,
      };
    })
    .sort((a, b) =>
      `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`),
    );
}

export async function fetchTopPods(): Promise<{ rows: PodMetricRow[]; error: string | null }> {
  try {
    const res = await request('/apis/metrics.k8s.io/v1beta1/pods');
    const items = (res.items ?? []) as PodMetricsItem[];
    const rows: PodMetricRow[] = items.map(p => {
      const cpu = p.containers.reduce((s, c) => s + parseQuantity(c.usage.cpu), 0);
      const memory = p.containers.reduce((s, c) => s + parseQuantity(c.usage.memory), 0);
      return {
        namespace: p.metadata.namespace,
        name: p.metadata.name,
        cpuCores: cpu,
        memoryBytes: memory,
      };
    });
    return { rows, error: null };
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
