import yaml from 'js-yaml';
import { ManagedAccount } from './discovery';
import { Rule, UiAccessLevel } from './rbac';

/**
 * A cluster-independent description of the accounts this plugin manages, so a set of
 * permissions can be reviewed, kept in git, or rebuilt on another cluster.
 *
 * Deliberately carries no credentials. Tokens are per-cluster and re-issued on apply;
 * putting them in an exported file would be handing out a permanent key in a format people
 * commit to repositories.
 */

export const PORTABLE_VERSION = 1;

export type PortableAccount = {
  name: string;
  namespace: string;
  scope: 'Namespaced' | 'Cluster';
  namespaces: string[];
  uiAccess: UiAccessLevel;
  rules: Rule[];
};

export type PortableBundle = {
  version: number;
  exportedAt?: string;
  accounts: PortableAccount[];
};

export function toPortable(account: ManagedAccount): PortableAccount {
  return {
    name: account.name,
    namespace: account.namespace,
    scope: account.scope,
    namespaces: [...account.bindingNamespaces],
    uiAccess: account.uiAccess,
    rules: account.rules,
  };
}

export function exportBundle(accounts: ManagedAccount[], exportedAt?: string): string {
  const bundle: PortableBundle = {
    version: PORTABLE_VERSION,
    ...(exportedAt ? { exportedAt } : {}),
    accounts: accounts.map(toPortable),
  };
  return yaml.dump(bundle, { noRefs: true, lineWidth: -1 });
}

export type ParseResult = {
  bundle: PortableBundle | null;
  errors: string[];
};

const VALID_LEVELS: UiAccessLevel[] = ['none', 'namespaces', 'metrics', 'workloads', 'kubelet'];

function parseRules(raw: any, where: string, errors: string[]): Rule[] {
  if (!Array.isArray(raw)) {
    errors.push(`${where}: rules must be a list.`);
    return [];
  }
  const rules: Rule[] = [];
  for (const [i, r] of raw.entries()) {
    const apiGroups = Array.isArray(r?.apiGroups) ? r.apiGroups.map(String) : null;
    const resources = Array.isArray(r?.resources) ? r.resources.map(String) : null;
    const verbs = Array.isArray(r?.verbs) ? r.verbs.map(String) : null;
    if (!apiGroups || !resources || !verbs) {
      errors.push(`${where}: rule ${i + 1} needs apiGroups, resources and verbs as lists.`);
      continue;
    }
    rules.push({ apiGroups, resources, verbs: verbs as Rule['verbs'] });
  }
  return rules;
}

/**
 * Parsed defensively: this file comes from outside the cluster and drives RBAC writes.
 * Anything unrecognised is reported rather than coerced into a permission nobody intended.
 */
export function parseBundle(text: string): ParseResult {
  const errors: string[] = [];
  let doc: any;
  try {
    doc = yaml.load(text);
  } catch (err) {
    return { bundle: null, errors: [`Not valid YAML: ${String(err)}`] };
  }
  if (!doc || typeof doc !== 'object') {
    return { bundle: null, errors: ['File is empty or not a YAML mapping.'] };
  }
  if (doc.version !== PORTABLE_VERSION) {
    errors.push(
      `Unsupported version ${String(doc.version)}; this build reads version ${PORTABLE_VERSION}.`,
    );
    return { bundle: null, errors };
  }
  if (!Array.isArray(doc.accounts)) {
    return { bundle: null, errors: ['Missing an "accounts" list.'] };
  }

  const accounts: PortableAccount[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of doc.accounts.entries()) {
    const where = `account ${i + 1}${raw?.name ? ` (${raw.name})` : ''}`;
    if (typeof raw?.name !== 'string' || raw.name.length === 0) {
      errors.push(`${where}: missing a name.`);
      continue;
    }
    if (typeof raw?.namespace !== 'string' || raw.namespace.length === 0) {
      errors.push(`${where}: missing the namespace for the ServiceAccount.`);
      continue;
    }
    const scope = raw.scope === 'Cluster' ? 'Cluster' : 'Namespaced';
    const namespaces = Array.isArray(raw.namespaces) ? raw.namespaces.map(String) : [];
    if (scope === 'Namespaced' && namespaces.length === 0) {
      errors.push(`${where}: a namespaced account needs at least one namespace.`);
      continue;
    }
    const uiAccess: UiAccessLevel = VALID_LEVELS.includes(raw.uiAccess)
      ? raw.uiAccess
      : 'namespaces';
    if (raw.uiAccess !== undefined && !VALID_LEVELS.includes(raw.uiAccess)) {
      errors.push(`${where}: unknown uiAccess "${String(raw.uiAccess)}", defaulting to namespaces.`);
    }
    const rules = parseRules(raw.rules, where, errors);
    if (rules.length === 0) {
      errors.push(`${where}: no usable rules, skipping.`);
      continue;
    }
    const key = `${raw.namespace}/${raw.name}`;
    if (seen.has(key)) {
      errors.push(`${where}: duplicate of an earlier entry, skipping.`);
      continue;
    }
    seen.add(key);
    accounts.push({ name: raw.name, namespace: raw.namespace, scope, namespaces, uiAccess, rules });
  }

  return { bundle: { version: PORTABLE_VERSION, accounts }, errors };
}

/** Namespaces an import needs that the target cluster does not have. */
export function missingNamespaces(
  accounts: PortableAccount[],
  available: string[],
): string[] {
  const have = new Set(available);
  const missing = new Set<string>();
  for (const a of accounts) {
    for (const ns of a.namespaces) {
      if (!have.has(ns)) missing.add(ns);
    }
    if (!have.has(a.namespace)) missing.add(a.namespace);
  }
  return [...missing].sort();
}
