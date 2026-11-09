import { patch, post, request } from '@kinvolk/headlamp-plugin/lib/ApiProxy';
import yaml from 'js-yaml';

export type AnyResource = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string };
  [k: string]: any;
};

function urlFor(res: AnyResource): string {
  const { apiVersion, kind, metadata } = res;
  const isCore = !apiVersion.includes('/');
  const base = isCore ? `/api/${apiVersion}` : `/apis/${apiVersion}`;
  const plural = kindToPlural(kind);
  if (metadata.namespace) {
    return `${base}/namespaces/${metadata.namespace}/${plural}`;
  }
  return `${base}/${plural}`;
}

function getUrlFor(res: AnyResource): string {
  return `${urlFor(res)}/${res.metadata.name}`;
}

function kindToPlural(kind: string): string {
  const map: Record<string, string> = {
    ServiceAccount: 'serviceaccounts',
    Secret: 'secrets',
    ConfigMap: 'configmaps',
    Role: 'roles',
    RoleBinding: 'rolebindings',
    ClusterRole: 'clusterroles',
    ClusterRoleBinding: 'clusterrolebindings',
    Namespace: 'namespaces',
    Endpoints: 'endpoints',
    Ingress: 'ingresses',
    IngressClass: 'ingressclasses',
    NetworkPolicy: 'networkpolicies',
    StorageClass: 'storageclasses',
    PodDisruptionBudget: 'poddisruptionbudgets',
    HorizontalPodAutoscaler: 'horizontalpodautoscalers',
    PersistentVolume: 'persistentvolumes',
    PersistentVolumeClaim: 'persistentvolumeclaims',
    PriorityClass: 'priorityclasses',
    Middleware: 'middlewares',
    IngressRoute: 'ingressroutes',
  };
  const mapped = map[kind];
  if (mapped) return mapped;
  // Naive fallback. Kinds ending in s/x/z or y need the map above — add them there
  // rather than relying on this.
  const lower = kind.toLowerCase();
  if (lower.endsWith('y')) return `${lower.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(lower)) return `${lower}es`;
  return `${lower}s`;
}

/**
 * Status code from whatever ApiProxy threw. Headlamp's ApiError carries `status`;
 * older paths only give us a message, hence the regex fallback.
 */
function statusOf(err: unknown): number | null {
  const anyErr = err as any;
  const direct = anyErr?.status ?? anyErr?.statusCode ?? anyErr?.response?.status;
  if (typeof direct === 'number') return direct;
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/\b(4\d\d|5\d\d)\b/);
  return m ? Number(m[1]) : null;
}

/**
 * 409: a create that found the name taken, or a write whose resourceVersion is stale ("the
 * object has been modified").
 */
export function isConflict(err: unknown): boolean {
  if (statusOf(err) === 409) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /already\s*exists|\bconflict\b|the object has been modified/i.test(msg);
}

export function isNotFound(err: unknown): boolean {
  if (!err) return false;
  if (statusOf(err) === 404) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /not\s*found/i.test(msg);
}

/**
 * Merge the desired object onto the live one instead of blindly replacing it.
 *
 * A plain PUT of `{apiVersion, kind, metadata: {name, namespace}, data}` wipes every
 * field the caller did not restate — labels, annotations, ownerReferences, and for a
 * ConfigMap also `binaryData`. That silently detaches Helm-managed objects from their
 * release. Top-level keys the caller *does* set (data, rules, subjects...) still replace
 * wholesale, so removing a key from a ConfigMap still removes it.
 */
export function mergeOntoExisting(current: any, desired: AnyResource): any {
  const currentMeta = current?.metadata ?? {};
  const desiredMeta: any = desired.metadata ?? {};
  return {
    ...current,
    ...desired,
    metadata: {
      ...currentMeta,
      ...desiredMeta,
      labels: { ...(currentMeta.labels ?? {}), ...(desiredMeta.labels ?? {}) },
      annotations: { ...(currentMeta.annotations ?? {}), ...(desiredMeta.annotations ?? {}) },
      resourceVersion: currentMeta.resourceVersion,
    },
  };
}

export async function applyResources(resources: AnyResource[]): Promise<void> {
  for (const res of resources) {
    await createOrUpdate(res);
  }
}

/**
 * The subset of `resources` that already exists. `applyResources` updates whatever it finds,
 * which is right for an edit and wrong for a create: there it silently takes over someone
 * else's ServiceAccount or overwrites a cluster-scoped role another account relies on.
 * Only a 404 counts as absent: an object we could not read might well exist, so any other
 * failure stops the create instead of letting it overwrite blind.
 */
export async function findExisting(resources: AnyResource[]): Promise<AnyResource[]> {
  const found = await Promise.all(
    resources.map(async res => {
      try {
        await request(getUrlFor(res));
        return res;
      } catch (err) {
        if (isNotFound(err)) return null;
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not check whether ${describeResource(res)} exists: ${msg}`);
      }
    }),
  );
  return found.filter((r): r is AnyResource => r !== null);
}

/**
 * Create only. A 409 is an error here, never a cue to update what is there — checking with
 * `findExisting` first and then calling `applyResources` leaves a window in which someone
 * else's object would be overwritten. Returns what the API server stored.
 */
export async function createResource(res: AnyResource): Promise<any> {
  try {
    return await post(urlFor(res), res, false);
  } catch (err) {
    if (isConflict(err)) throw new Error(`${describeResource(res)} already exists.`);
    throw err;
  }
}

export async function createResources(resources: AnyResource[]): Promise<void> {
  for (const res of resources) {
    await createResource(res);
  }
}

/**
 * Update an object the user has been editing since `live` was read. The PUT carries that
 * resourceVersion, so a change someone made in the meantime fails with 409 instead of being
 * silently overwritten — `applyResources` re-reads first and so can never notice one.
 * Returns what the API server stored.
 */
export async function updateResource(live: any, desired: AnyResource): Promise<any> {
  return request(getUrlFor(desired), {
    method: 'PUT',
    body: JSON.stringify(mergeOntoExisting(live, desired)),
    headers: { 'Content-Type': 'application/json' },
  });
}

export function describeResource(res: AnyResource): string {
  const ns = res.metadata.namespace ? ` in ${res.metadata.namespace}` : '';
  return `${res.kind} ${res.metadata.name}${ns}`;
}

async function createOrUpdate(res: AnyResource): Promise<void> {
  try {
    await post(urlFor(res), res, false);
    return;
  } catch (err) {
    if (!isConflict(err)) throw err;
  }
  const url = getUrlFor(res);
  const current: any = await request(url);
  const body = mergeOntoExisting(current, res);
  await request(url, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function deleteResource(
  apiVersion: string,
  kind: string,
  name: string,
  namespace?: string,
): Promise<void> {
  const res = { apiVersion, kind, metadata: { name, namespace } };
  const url = getUrlFor(res);
  try {
    await request(url, { method: 'DELETE' });
  } catch (err: any) {
    if (!isNotFound(err)) throw err;
  }
}

/**
 * Delete only when the live object carries every one of `labels`. For deletes driven by a
 * name read back from the cluster, which may belong to someone else — a role name taken from
 * a hand-made binding can be `cluster-admin`. Returns whether anything was deleted.
 */
export async function deleteIfLabelled(
  apiVersion: string,
  kind: string,
  name: string,
  labels: Record<string, string>,
  namespace?: string,
): Promise<boolean> {
  const res = { apiVersion, kind, metadata: { name, namespace } };
  let live: any;
  try {
    live = await request(getUrlFor(res));
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
  const actual = live?.metadata?.labels ?? {};
  if (!Object.entries(labels).every(([k, v]) => actual[k] === v)) return false;
  await deleteResource(apiVersion, kind, name, namespace);
  return true;
}

export async function patchResource(
  apiVersion: string,
  kind: string,
  name: string,
  body: any,
  namespace?: string,
): Promise<void> {
  const res = { apiVersion, kind, metadata: { name, namespace } };
  const url = getUrlFor(res);
  await patch(url, body, false);
}

export type TokenSecretData = {
  token: string;
  caCrtBase64: string;
  namespace: string;
};

function readTokenSecret(secret: any, fallbackNamespace: string): TokenSecretData | null {
  const data = secret?.data ?? {};
  if (!data.token || !data['ca.crt']) return null;
  return {
    token: atob(data.token),
    caCrtBase64: data['ca.crt'],
    namespace: data.namespace ? atob(data.namespace) : fallbackNamespace,
  };
}

export async function waitForToken(
  namespace: string,
  secretName: string,
  timeoutMs = 20000,
): Promise<TokenSecretData> {
  const url = `/api/v1/namespaces/${namespace}/secrets/${secretName}`;
  const started = Date.now();
  let lastErr: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const parsed = readTokenSecret(await request(url), namespace);
      if (parsed) return parsed;
    } catch (err) {
      lastErr = err;
    }
    await new Promise(r => setTimeout(r, 750));
  }
  throw new Error(
    `Timed out waiting for token in secret ${namespace}/${secretName}` +
      (lastErr ? `: ${String(lastErr)}` : ''),
  );
}

export async function detectApiServerUrl(): Promise<string | null> {
  try {
    const cm: any = await request('/api/v1/namespaces/kube-public/configmaps/cluster-info');
    const kc = cm?.data?.kubeconfig;
    if (typeof kc === 'string') {
      const parsed = yaml.load(kc) as any;
      const server = parsed?.clusters?.[0]?.cluster?.server;
      if (typeof server === 'string' && server.startsWith('http')) return server;
    }
  } catch {
    // fall through
  }
  try {
    const ep: any = await request('/api/v1/namespaces/default/endpoints/kubernetes');
    const subset = ep?.subsets?.[0];
    const addr = subset?.addresses?.[0];
    const host = addr?.hostname ?? addr?.ip;
    const httpsPort = subset?.ports?.find(
      (p: any) => p.name === 'https' || p.port === 443 || p.port === 6443,
    );
    const port = httpsPort?.port ?? subset?.ports?.[0]?.port;
    if (host && port) return `https://${host}:${port}`;
  } catch {
    // ignore
  }
  return null;
}

export async function fetchToken(
  namespace: string,
  secretName: string,
): Promise<TokenSecretData | null> {
  try {
    const secret = await request(`/api/v1/namespaces/${namespace}/secrets/${secretName}`);
    return readTokenSecret(secret, namespace);
  } catch {
    return null;
  }
}
