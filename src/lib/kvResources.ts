import { request } from '@kinvolk/headlamp-plugin/lib/ApiProxy';
import { applyResources, deleteResource } from './apply';

export type ConfigMapResource = {
  metadata: {
    name: string;
    namespace: string;
    resourceVersion?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  data?: Record<string, string>;
  binaryData?: Record<string, string>;
};

export type SecretResource = {
  metadata: {
    name: string;
    namespace: string;
    resourceVersion?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  type?: string;
  data?: Record<string, string>;
  stringData?: Record<string, string>;
};

type AnyList = { items?: any[] };

/**
 * Listing every Secret in the cluster pulls all of their `data` into the browser just to
 * filter it back down to one namespace. When the namespace filter is set we ask the API
 * server for exactly those namespaces instead.
 */
async function listScoped<T>(plural: string, namespaces: string[]): Promise<T[]> {
  if (namespaces.length === 0) {
    const res = (await request(`/api/v1/${plural}`)) as AnyList;
    return (res?.items ?? []) as T[];
  }
  const perNamespace = await Promise.all(
    namespaces.map(async ns => {
      try {
        const res = (await request(`/api/v1/namespaces/${ns}/${plural}`)) as AnyList;
        return (res?.items ?? []) as T[];
      } catch {
        // A namespace the account cannot read must not blank out the whole list.
        return [] as T[];
      }
    }),
  );
  return perNamespace.flat();
}

export async function listConfigMaps(namespaces: string[] = []): Promise<ConfigMapResource[]> {
  try {
    return await listScoped<ConfigMapResource>('configmaps', namespaces);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[access-builder] listConfigMaps failed', err);
    return [];
  }
}

export async function listSecrets(namespaces: string[] = []): Promise<SecretResource[]> {
  try {
    return await listScoped<SecretResource>('secrets', namespaces);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[access-builder] listSecrets failed', err);
    return [];
  }
}

export async function getConfigMap(
  namespace: string,
  name: string,
): Promise<ConfigMapResource | null> {
  try {
    return (await request(
      `/api/v1/namespaces/${namespace}/configmaps/${name}`,
    )) as ConfigMapResource;
  } catch {
    return null;
  }
}

export async function getSecret(namespace: string, name: string): Promise<SecretResource | null> {
  try {
    return (await request(`/api/v1/namespaces/${namespace}/secrets/${name}`)) as SecretResource;
  } catch {
    return null;
  }
}

export async function applyConfigMap(cm: ConfigMapResource): Promise<void> {
  await applyResources([
    {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: cm.metadata.name, namespace: cm.metadata.namespace },
      data: cm.data ?? {},
    },
  ]);
}

export async function applySecret(sec: SecretResource): Promise<void> {
  await applyResources([
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: sec.metadata.name, namespace: sec.metadata.namespace },
      type: sec.type ?? 'Opaque',
      data: sec.data ?? {},
    },
  ]);
}

export async function deleteConfigMap(namespace: string, name: string): Promise<void> {
  await deleteResource('v1', 'ConfigMap', name, namespace);
}

export async function deleteSecret(namespace: string, name: string): Promise<void> {
  await deleteResource('v1', 'Secret', name, namespace);
}

export const SYSTEM_CONFIGMAP_NAMES = new Set(['kube-root-ca.crt']);
export const SYSTEM_SECRET_TYPES = new Set([
  'kubernetes.io/service-account-token',
  'helm.sh/release.v1',
]);

export function isSystemConfigMap(cm: ConfigMapResource): boolean {
  return SYSTEM_CONFIGMAP_NAMES.has(cm.metadata.name);
}

export function isSystemSecret(sec: SecretResource): boolean {
  return SYSTEM_SECRET_TYPES.has(sec.type ?? '');
}

export function encodeUtf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Decode only when the bytes really are UTF-8 text; return null otherwise.
 *
 * A non-fatal TextDecoder replaces every undecodable byte with U+FFFD without complaining,
 * so a keystore or a binary key round-tripped through the edit form came back permanently
 * mangled. Callers are expected to keep such values as opaque base64 instead.
 */
export function tryDecodeBase64ToUtf8(value: string): string | null {
  try {
    const bin = atob(value);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function decodeBase64ToUtf8(value: string): string {
  return tryDecodeBase64ToUtf8(value) ?? value;
}
