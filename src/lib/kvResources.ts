import { request } from '@kinvolk/headlamp-plugin/lib/ApiProxy';
import { createResource, deleteResource, isConflict, updateResource } from './apply';

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
 *
 * Throws when nothing could be read, so the tab shows the error instead of an empty list
 * that looks like "no Secrets here".
 */
async function listScoped<T>(plural: string, namespaces: string[]): Promise<T[]> {
  if (namespaces.length === 0) {
    const res = (await request(`/api/v1/${plural}`)) as AnyList;
    return (res?.items ?? []) as T[];
  }
  const perNamespace = await Promise.allSettled(
    namespaces.map(async ns => {
      const res = (await request(`/api/v1/namespaces/${ns}/${plural}`)) as AnyList;
      return (res?.items ?? []) as T[];
    }),
  );
  const read = perNamespace.filter(
    (r): r is PromiseFulfilledResult<T[]> => r.status === 'fulfilled',
  );
  // A namespace the account cannot read must not blank out the whole list.
  if (read.length === 0) {
    throw (perNamespace[0] as PromiseRejectedResult).reason;
  }
  return read.flatMap(r => r.value);
}

export function listConfigMaps(namespaces: string[] = []): Promise<ConfigMapResource[]> {
  return listScoped<ConfigMapResource>('configmaps', namespaces);
}

export function listSecrets(namespaces: string[] = []): Promise<SecretResource[]> {
  return listScoped<SecretResource>('secrets', namespaces);
}

type ListedObject = { metadata: { name: string; namespace: string } };

/** What the ConfigMap and Secret tables show for the current switches and filter text. */
export function filterKvItems<T extends ListedObject>(
  items: T[],
  opts: { hideSystem: boolean; isSystem: (item: T) => boolean; namespaces: string[]; text: string },
): T[] {
  const nsSet = new Set(opts.namespaces);
  const text = opts.text.toLowerCase();
  return items
    .filter(i => !(opts.hideSystem && opts.isSystem(i)))
    .filter(i => nsSet.size === 0 || nsSet.has(i.metadata.namespace))
    .filter(
      i =>
        !text ||
        i.metadata.name.toLowerCase().includes(text) ||
        i.metadata.namespace.toLowerCase().includes(text),
    )
    .sort((a, b) =>
      `${a.metadata.namespace}/${a.metadata.name}`.localeCompare(
        `${b.metadata.namespace}/${b.metadata.name}`,
      ),
    );
}

const DNS_LABEL = '[a-z0-9]([-a-z0-9]*[a-z0-9])?';
const DNS_SUBDOMAIN = new RegExp(`^${DNS_LABEL}(\\.${DNS_LABEL})*$`);

/** ConfigMap and Secret names: lowercase DNS subdomain, no leading or trailing "-" or ".". */
export function isDnsSubdomain(name: string): boolean {
  return name.length <= 253 && DNS_SUBDOMAIN.test(name);
}

/**
 * Rows for a typed Secret: the keys the type requires come first, reusing what was already
 * typed under them, and every other row that has a value is kept. Rows without one — the
 * empty `tls.crt` left over from switching TLS to basic auth — are dropped, or they would
 * block saving with "empty value" errors for keys the new type does not even want.
 */
export function withRequiredKeys<T extends { key: string; value: string }>(
  entries: T[],
  required: string[],
  blank: (key: string) => T,
): T[] {
  const byKey = new Map(entries.map(e => [e.key, e]));
  const rest = entries.filter(e => e.key && e.value && !required.includes(e.key));
  return [...required.map(k => byKey.get(k) ?? blank(k)), ...rest];
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

/**
 * Create when `live` is null, otherwise update the object as it was when editing started.
 * Create-or-update would let "New ConfigMap" with a taken name overwrite the existing one,
 * and an edit overwrite whatever changed since the form was loaded.
 */
export async function saveConfigMap(
  cm: ConfigMapResource,
  live: ConfigMapResource | null,
): Promise<void> {
  const manifest = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: cm.metadata.name, namespace: cm.metadata.namespace },
    data: cm.data ?? {},
  };
  await saveWith(live, manifest);
}

async function saveWith(live: { metadata: { name: string } } | null, manifest: any) {
  try {
    await (live ? updateResource(live, manifest) : createResource(manifest));
  } catch (err) {
    if (live && isConflict(err)) {
      throw new Error(
        `${manifest.kind} ${manifest.metadata.namespace}/${manifest.metadata.name} was changed by someone else since you opened it. Reload it and edit again.`,
      );
    }
    throw err;
  }
}

export async function saveSecret(sec: SecretResource, live: SecretResource | null): Promise<void> {
  const manifest = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: sec.metadata.name, namespace: sec.metadata.namespace },
    type: sec.type ?? 'Opaque',
    data: sec.data ?? {},
  };
  await saveWith(live, manifest);
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
