import { patch, post, request } from '@kinvolk/headlamp-plugin/lib/ApiProxy';
import yaml from 'js-yaml';

type AnyResource = {
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
    Role: 'roles',
    RoleBinding: 'rolebindings',
    ClusterRole: 'clusterroles',
    ClusterRoleBinding: 'clusterrolebindings',
  };
  return map[kind] ?? kind.toLowerCase() + 's';
}

export async function applyResources(resources: AnyResource[]): Promise<void> {
  for (const res of resources) {
    await createOrUpdate(res);
  }
}

async function createOrUpdate(res: AnyResource): Promise<void> {
  try {
    await post(urlFor(res), res, false);
    return;
  } catch (err) {
    if (!isConflict(err) && !isAlreadyExists(err)) throw err;
  }
  const url = getUrlFor(res);
  const current: any = await request(url);
  const body: any = {
    ...res,
    metadata: { ...res.metadata, resourceVersion: current?.metadata?.resourceVersion },
  };
  await request(url, {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

function isConflict(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b409\b|conflict/i.test(msg);
}

function isAlreadyExists(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already\s*exists/i.test(msg);
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

export function isNotFound(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /404|not\s*found/i.test(msg);
}

export type TokenSecretData = {
  token: string;
  caCrtBase64: string;
  namespace: string;
};

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
      const secret: any = await request(url);
      const data = secret?.data ?? {};
      if (data.token && data['ca.crt']) {
        return {
          token: atob(data.token),
          caCrtBase64: data['ca.crt'],
          namespace: data.namespace ? atob(data.namespace) : namespace,
        };
      }
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
    const httpsPort = subset?.ports?.find((p: any) => p.name === 'https' || p.port === 443 || p.port === 6443);
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
    const secret: any = await request(`/api/v1/namespaces/${namespace}/secrets/${secretName}`);
    const data = secret?.data ?? {};
    if (data.token && data['ca.crt']) {
      return {
        token: atob(data.token),
        caCrtBase64: data['ca.crt'],
        namespace: data.namespace ? atob(data.namespace) : namespace,
      };
    }
    return null;
  } catch {
    return null;
  }
}
