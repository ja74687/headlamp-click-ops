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

export async function listConfigMaps(): Promise<ConfigMapResource[]> {
  try {
    const res = (await request('/api/v1/configmaps')) as AnyList;
    return (res?.items ?? []) as ConfigMapResource[];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[access-builder] listConfigMaps failed', err);
    return [];
  }
}

export async function listSecrets(): Promise<SecretResource[]> {
  try {
    const res = (await request('/api/v1/secrets')) as AnyList;
    return (res?.items ?? []) as SecretResource[];
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
    return (await request(`/api/v1/namespaces/${namespace}/configmaps/${name}`)) as ConfigMapResource;
  } catch {
    return null;
  }
}

export async function getSecret(
  namespace: string,
  name: string,
): Promise<SecretResource | null> {
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

export function decodeBase64ToUtf8(value: string): string {
  try {
    const bin = atob(value);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return value;
  }
}
