import { request } from '@kinvolk/headlamp-plugin/lib/ApiProxy';
import {
  createResource,
  deleteIfLabelled,
  deleteResource,
  isNotFound,
  patchResource,
  updateResource,
} from './apply';
import { htpasswdLine } from './htpasswd';
import { encodeUtf8ToBase64 } from './kvResources';
import { MANAGED_BY_LABEL } from './rbac';
import {
  atLeastVersion,
  CLICK_OPS_MANAGED_BY,
  friendlyWriteError,
  IngressHandling,
  IngressObject,
  isValidSourceRange,
  TraefikRuntime,
  Verdict,
} from './traefik';

/**
 * The protection an Ingress gets from its `nginx.ingress.kubernetes.io/*` annotations: read
 * for display, and edited for Ingresses that Traefik serves through its ingress-nginx
 * compatibility provider. There those annotations are the only protection that counts — the
 * same edit `kubectl annotate --overwrite` makes, from a form.
 *
 * How Traefik reads them was taken from its source (pkg/provider/kubernetes/ingress-nginx,
 * v3.6 and v3.7), since the docs list the annotations without their semantics.
 */

export const NGINX_PREFIX = 'nginx.ingress.kubernetes.io/';
export const FOR_INGRESS_LABEL = 'click-ops/for-ingress';

const ANN = {
  whitelist: `${NGINX_PREFIX}whitelist-source-range`,
  allowlist: `${NGINX_PREFIX}allowlist-source-range`,
  authType: `${NGINX_PREFIX}auth-type`,
  authSecret: `${NGINX_PREFIX}auth-secret`,
  authSecretType: `${NGINX_PREFIX}auth-secret-type`,
  authRealm: `${NGINX_PREFIX}auth-realm`,
  forceSslRedirect: `${NGINX_PREFIX}force-ssl-redirect`,
};

const YES: Verdict = { allowed: 'yes' };

/** What the running Traefik version makes of these annotations. */
export type CompatSemantics = {
  /** The allowlist annotations exist only from Traefik 3.7 on. */
  allowlist: 'yes' | 'no' | 'unknown';
  /** 3.7 redirects a TLS Ingress to HTTPS unless ssl-redirect says otherwise. */
  sslRedirectDefaultWithTls: boolean | null;
  /** Before 3.7 a missing or unreadable auth Secret is only logged and the route stays open. */
  authFailsOpen: boolean | null;
  /** "3.7.17", for messages; null when the image tag does not say. */
  version: string | null;
};

export const UNKNOWN_SEMANTICS: CompatSemantics = {
  allowlist: 'unknown',
  sslRedirectDefaultWithTls: null,
  authFailsOpen: null,
  version: null,
};

export function compatSemantics(runtime: TraefikRuntime): CompatSemantics {
  if (runtime.status !== 'known' || !runtime.version) return UNKNOWN_SEMANTICS;
  const v = runtime.version;
  const v37 = atLeastVersion(v, 3, 7);
  return {
    allowlist: v37 ? 'yes' : 'no',
    sslRedirectDefaultWithTls: v37 ? true : null,
    authFailsOpen: !v37,
    version: `${v.major}.${v.minor}.${v.patch}`,
  };
}

export type NginxProtection = {
  /** null when no allowlist is in force by the annotations: every address gets through. */
  allowlist: string[] | null;
  /** Whether the running Traefik enforces allowlist annotations at all. */
  allowlistEnforced: CompatSemantics['allowlist'];
  /** null when no auth-type is set. */
  auth: { type: string; secret: string | null; secretType: string; realm: string | null } | null;
  authUrl: string | null;
  /**
   * `default-tls`: no annotation, but the Ingress has TLS and Traefik 3.7 redirects such
   * Ingresses by default. `default`: no annotation and nothing more is known.
   */
  httpsRedirect: 'forced' | 'on' | 'off' | 'default-tls' | 'default';
  /** Annotations that contradict each other, do nothing, or do less than they seem to. */
  problems: string[];
};

/** The protection an Ingress gets from its nginx.ingress.kubernetes.io annotations. */
export function nginxProtection(
  ingress: IngressObject,
  semantics: CompatSemantics = UNKNOWN_SEMANTICS
): NginxProtection {
  const ann = ingress.metadata.annotations ?? {};
  const raw = (key: string): string | undefined => {
    const v = ann[NGINX_PREFIX + key];
    return typeof v === 'string' ? v : undefined;
  };
  const get = (key: string): string | null => {
    const v = raw(key);
    return v !== undefined && v.trim() !== '' ? v.trim() : null;
  };
  const problems: string[] = [];

  // Traefik takes allowlist-source-range whenever the key is present — even empty — and only
  // falls back to whitelist-source-range without it; an empty value means no filtering at all.
  const allowRaw = raw('allowlist-source-range');
  const whiteRaw = raw('whitelist-source-range');
  let rangeValue: string | undefined;
  if (allowRaw !== undefined) {
    rangeValue = allowRaw;
    if (allowRaw.trim() === '') {
      problems.push(
        'allowlist-source-range is set but empty, which also switches off whitelist-source-range: no address is filtered.'
      );
    } else if (whiteRaw !== undefined && whiteRaw.trim() !== allowRaw.trim()) {
      problems.push(
        'Both allowlist-source-range and whitelist-source-range are set with different values; Traefik uses allowlist-source-range.'
      );
    }
  } else {
    rangeValue = whiteRaw;
  }
  const allowlist =
    rangeValue && rangeValue.trim()
      ? rangeValue
          .split(',')
          .map(s => s.trim())
          .filter(s => s.length > 0)
      : null;
  const everyone = (allowlist ?? []).filter(r => /\/0$/.test(r));
  if (everyone.length > 0) {
    problems.push(`The allowlist contains ${everyone.join(', ')}, which lets every address in.`);
  }
  if (allowlist && semantics.allowlist === 'no') {
    problems.push(
      `Traefik ${semantics.version} ignores IP allowlist annotations (they arrived in 3.7): this list is not enforced.`
    );
  }

  const authType = get('auth-type');
  const authSecret = get('auth-secret');
  if (authType && !authSecret) problems.push('auth-type is set without auth-secret.');
  if (authSecret && !authType) {
    problems.push('auth-secret is set without auth-type, so no password is asked for.');
  }
  const auth = authType
    ? {
        type: authType,
        secret: authSecret,
        secretType: get('auth-secret-type') ?? 'auth-file',
        realm: get('auth-realm'),
      }
    : null;
  if (auth && semantics.authFailsOpen) {
    problems.push(
      `With Traefik ${semantics.version}, a missing or unreadable auth Secret leaves the route without a password (it is only logged).`
    );
  }

  // Traefik 3.7 reads these as `strings.EqualFold(value, "true")`, untrimmed: "1" is off.
  const flag = (key: string): boolean | undefined => {
    const v = raw(key);
    if (v === undefined) return undefined;
    if (v.toLowerCase() === 'true') return true;
    if (v.toLowerCase() !== 'false') {
      problems.push(
        `${key} is "${v}": Traefik 3.7 reads only "true" as on, so this counts as off (older versions read it differently).`
      );
    }
    return false;
  };
  const force = flag('force-ssl-redirect');
  const ssl = flag('ssl-redirect');
  const hasTls = (ingress.spec?.tls ?? []).length > 0;
  const httpsRedirect =
    force === true
      ? 'forced'
      : ssl === true
      ? 'on'
      : ssl === false
      ? 'off'
      : hasTls && semantics.sslRedirectDefaultWithTls
      ? 'default-tls'
      : 'default';

  return {
    allowlist,
    allowlistEnforced: semantics.allowlist,
    auth,
    authUrl: get('auth-url'),
    httpsRedirect,
    problems,
  };
}

/**
 * Whether the nginx annotations may be edited: only where something enforces them. Traefik's
 * native provider ignores them, and writing them there would look like protection again.
 */
export function nginxEditVerdict(handling: IngressHandling): Verdict {
  switch (handling.kind) {
    case 'nginx-compat':
      return YES;
    case 'unknown':
      return { allowed: 'confirm', reason: handling.reason };
    case 'native':
      return {
        allowed: 'no',
        reason:
          'Traefik serves this Ingress through its native provider, which ignores nginx.ingress.kubernetes.io annotations. Attach middlewares instead.',
      };
    case 'not-traefik':
      return {
        allowed: 'no',
        reason: `Traefik does not serve this Ingress${
          handling.controller ? ` (its class belongs to ${handling.controller})` : ''
        }.`,
      };
  }
}

/** Per section of the dialog, what the running Traefik version makes of an edit. */
export function nginxSectionVerdicts(
  handling: IngressHandling,
  semantics: CompatSemantics
): { allowlist: Verdict; auth: Verdict; https: Verdict } {
  const base = nginxEditVerdict(handling);
  if (base.allowed !== 'yes') return { allowlist: base, auth: base, https: base };
  const allowlist: Verdict =
    semantics.allowlist === 'yes'
      ? YES
      : semantics.allowlist === 'no'
      ? {
          allowed: 'no',
          reason: `Traefik ${semantics.version} ignores IP allowlist annotations; they arrived in Traefik 3.7.`,
        }
      : {
          allowed: 'confirm',
          reason:
            "Traefik's version could not be read from its image, and IP allowlist annotations only work from Traefik 3.7 on.",
        };
  const auth: Verdict = semantics.authFailsOpen
    ? {
        allowed: 'confirm',
        reason: `With Traefik ${semantics.version}, a missing or unreadable auth Secret leaves the route without a password.`,
      }
    : YES;
  return { allowlist, auth, https: YES };
}

export type NginxProtectionForm = {
  allowlist: string[];
  /** `keep` leaves the current password set-up untouched; `set` writes a new user. */
  auth: 'off' | 'keep' | 'set';
  username: string;
  password: string;
  realm: string;
  forceHttps: boolean;
};

/** The Secret this page keeps the htpasswd line of an Ingress in. */
export function basicAuthSecretFor(ingressName: string): string {
  return `${ingressName}-basic-auth`;
}

export function nginxFormFromIngress(ingress: IngressObject): NginxProtectionForm {
  const p = nginxProtection(ingress);
  return {
    allowlist: p.allowlist ?? [],
    auth: p.auth ? 'keep' : 'off',
    username: '',
    password: '',
    realm: p.auth?.realm ?? '',
    forceHttps: p.httpsRedirect === 'forced',
  };
}

function cleanList(values: string[]): string[] {
  return values.map(v => v.trim()).filter(v => v.length > 0);
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Name of the Secret auth-secret points at, when it is in the Ingress's own namespace. */
function localSecretName(value: string | null | undefined, namespace: string): string | null {
  const v = value?.trim();
  if (!v) return null;
  const slash = v.indexOf('/');
  if (slash === -1) return v;
  return v.slice(0, slash) === namespace ? v.slice(slash + 1) : null;
}

/** Other Ingresses in the namespace whose auth-secret is `secretName`. */
export function ingressesUsingSecret(
  ingresses: IngressObject[],
  namespace: string,
  secretName: string,
  except: string
): string[] {
  return ingresses
    .filter(
      i =>
        i.metadata.namespace === namespace &&
        i.metadata.name !== except &&
        localSecretName(i.metadata.annotations?.[ANN.authSecret], namespace) === secretName
    )
    .map(i => i.metadata.name);
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Label values stop at 63 characters, and the Secret is labelled with the Ingress name. */
const MAX_LABEL_VALUE = 63;

export function validateNginxForm(
  form: NginxProtectionForm,
  current: NginxProtection,
  ingressName: string
): string[] {
  const errors: string[] = [];
  for (const r of cleanList(form.allowlist)) {
    if (!isValidSourceRange(r)) errors.push(`"${r}" is not an IP address or CIDR network.`);
  }
  if (form.auth === 'keep' && !current.auth) {
    errors.push('There is no password set-up to keep.');
  }
  if (form.auth === 'set') {
    const user = form.username;
    if (!user) errors.push('Username is required.');
    else if (user !== user.trim()) errors.push('The username cannot start or end with a space.');
    if (user.startsWith('#')) {
      errors.push('The username cannot start with "#" — htpasswd reads such a line as a comment.');
    }
    if (user.includes(':')) errors.push('The username cannot contain ":".');
    if (CONTROL.test(user)) errors.push('The username cannot contain control characters.');
    if (!form.password) errors.push('Password is required.');
    if (CONTROL.test(form.password)) errors.push('The password cannot contain control characters.');
    if (ingressName.length > MAX_LABEL_VALUE) {
      errors.push(
        `Ingress names longer than ${MAX_LABEL_VALUE} characters cannot get a password here: the Secret is labelled with the name, and label values stop at ${MAX_LABEL_VALUE}.`
      );
    }
  }
  if (form.auth !== 'off' && /["\\]/.test(form.realm)) {
    errors.push('The realm cannot contain quotes or backslashes.');
  }
  if (form.auth !== 'off' && CONTROL.test(form.realm)) {
    errors.push('The realm cannot contain control characters.');
  }
  return errors;
}

/**
 * Changes that weaken protection or can lock people out. `confirm` ones must be acknowledged
 * before saving; `notice` ones are only shown. `sharedWith` lists other Ingresses using this
 * Ingress's own Secret.
 */
export function nginxRisks(
  current: NginxProtection,
  form: NginxProtectionForm,
  hosts: string[],
  sharedWith: string[] = []
): { level: 'confirm' | 'notice'; text: string }[] {
  const risks: { level: 'confirm' | 'notice'; text: string }[] = [];
  const where = hosts.length > 0 ? hosts.join(', ') : 'this Ingress';
  const next = cleanList(form.allowlist);
  const before = current.allowlist ?? [];
  const openAll = next.filter(r => /\/0$/.test(r) && !before.includes(r));
  if (current.allowlist && next.length === 0) {
    risks.push({
      level: 'confirm',
      text: `Removing the IP allowlist makes ${where} reachable from any address.`,
    });
  } else if (openAll.length > 0) {
    risks.push({
      level: 'confirm',
      text: `${openAll.join(', ')} lets every address in — the same as having no allowlist.`,
    });
  } else if (current.allowlist && before.some(r => !next.includes(r))) {
    risks.push({
      level: 'notice',
      text: 'Addresses taken off the list lose access as soon as this is saved — make sure the one you are using stays on it.',
    });
  } else if (!current.allowlist && next.length > 0) {
    risks.push({
      level: 'notice',
      text: 'From now on only the listed addresses get in — make sure the one you are using is among them.',
    });
  }
  if (current.auth && form.auth === 'off') {
    risks.push({
      level: 'confirm',
      text: `Removing the password lets anyone who reaches ${where} in without one.`,
    });
  }
  if (sharedWith.length > 0 && form.auth === 'set') {
    risks.push({
      level: 'confirm',
      text: `The password Secret is also used by ${sharedWith.join(
        ', '
      )} — their password changes too.`,
    });
  }
  if (sharedWith.length > 0 && form.auth === 'off' && current.auth) {
    risks.push({
      level: 'notice',
      text: `The password Secret stays, because ${sharedWith.join(', ')} still use it.`,
    });
  }
  if (current.httpsRedirect === 'forced' && !form.forceHttps) {
    risks.push({
      level: 'confirm',
      text: 'Plain HTTP will no longer be forced to HTTPS by this annotation.',
    });
  }
  return risks;
}

export type NginxChange = {
  /** Merge-patch annotations: a string sets, null deletes. Only keys whose value changes. */
  annotations: Record<string, string | null>;
  /** Written before the patch when a new password is set. */
  secret: ReturnType<typeof buildHtpasswdSecret> | null;
  /** This page's Secret, no longer referenced; deleted after the patch if it is ours. */
  dropSecret: string | null;
};

export function buildHtpasswdSecret(
  ingressName: string,
  namespace: string,
  username: string,
  password: string,
  salt?: string
) {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: basicAuthSecretFor(ingressName),
      namespace,
      labels: { [MANAGED_BY_LABEL]: CLICK_OPS_MANAGED_BY, [FOR_INGRESS_LABEL]: ingressName },
    },
    type: 'Opaque',
    // `auth` holding an htpasswd file is the auth-file format the annotations default to.
    data: { auth: encodeUtf8ToBase64(`${htpasswdLine(username, password, salt)}\n`) },
  };
}

/**
 * What saving `form` writes. Sections the user left as they were are not touched at all —
 * not even normalised — so a save never changes more than the form shows. `salt` is for
 * tests; `sharedWith` lists other Ingresses using this Ingress's own Secret, which then stays.
 */
export function buildNginxChange(
  ingress: IngressObject,
  form: NginxProtectionForm,
  salt?: string,
  sharedWith: string[] = []
): NginxChange {
  const { name, namespace } = ingress.metadata;
  const ann = ingress.metadata.annotations ?? {};
  const initial = nginxFormFromIngress(ingress);
  const desired: Record<string, string | null> = {};

  // Write the list under the name already in use; a new list gets the one the cluster's
  // README and tests use. Both names are cleared when the list is emptied.
  const list = cleanList(form.allowlist);
  if (!sameList(list, cleanList(initial.allowlist))) {
    const value = list.length > 0 ? list.join(',') : null;
    const hasAllow = ann[ANN.allowlist] !== undefined;
    const hasWhite = ann[ANN.whitelist] !== undefined;
    if (value === null) {
      desired[ANN.whitelist] = null;
      desired[ANN.allowlist] = null;
    } else {
      if (hasAllow) desired[ANN.allowlist] = value;
      if (hasWhite || !hasAllow) desired[ANN.whitelist] = value;
    }
  }

  const realm = form.realm.trim() || null;
  const ours = basicAuthSecretFor(name);
  let secret: NginxChange['secret'] = null;
  let dropSecret: string | null = null;
  if (form.auth === 'off' && initial.auth !== 'off') {
    desired[ANN.authType] = null;
    desired[ANN.authSecret] = null;
    desired[ANN.authSecretType] = null;
    desired[ANN.authRealm] = null;
    if (localSecretName(ann[ANN.authSecret], namespace) === ours && sharedWith.length === 0) {
      dropSecret = ours;
    }
  } else if (form.auth === 'set') {
    desired[ANN.authType] = 'basic';
    desired[ANN.authSecret] = ours;
    // Our Secret is an htpasswd file; an auth-map type left over would misread it.
    desired[ANN.authSecretType] = null;
    desired[ANN.authRealm] = realm;
    secret = buildHtpasswdSecret(name, namespace, form.username, form.password, salt);
  } else if (form.auth === 'keep' && realm !== (initial.realm.trim() || null)) {
    desired[ANN.authRealm] = realm;
  }

  if (form.forceHttps !== initial.forceHttps) {
    desired[ANN.forceSslRedirect] = form.forceHttps ? 'true' : null;
  }

  const annotations: Record<string, string | null> = {};
  for (const [key, v] of Object.entries(desired)) {
    if ((ann[key] ?? null) !== v) annotations[key] = v;
  }
  return { annotations, secret, dropSecret };
}

export function isOwnIngressSecret(
  secret: { metadata?: { labels?: Record<string, string> } } | null,
  ingressName: string
): boolean {
  const labels = secret?.metadata?.labels ?? {};
  return (
    labels[MANAGED_BY_LABEL] === CLICK_OPS_MANAGED_BY && labels[FOR_INGRESS_LABEL] === ingressName
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Writes a change so that a failure part-way never leaves the Ingress pointing at credentials
 * that are not there, and never deletes a Secret something points at:
 * - a Secret the Ingress does not use yet is written first, then the annotations point at it;
 * - a Secret it already uses is changed after the annotations, so a refused patch (409)
 *   changes nothing;
 * - a freshly created Secret is rolled back after a failed patch only if the Ingress, read
 *   again, does not point at it — a timed-out patch may still have landed;
 * - our own Secret is removed last, once nothing references it.
 */
export async function saveNginxProtection(
  ingress: IngressObject,
  change: NginxChange
): Promise<void> {
  const { name, namespace, resourceVersion } = ingress.metadata;
  const hasPatch = Object.keys(change.annotations).length > 0;
  const what = `Ingress ${namespace}/${name}`;
  const patch = async () => {
    try {
      await patchResource(
        'networking.k8s.io/v1',
        'Ingress',
        name,
        { metadata: { resourceVersion, annotations: change.annotations } },
        namespace
      );
    } catch (err) {
      throw friendlyWriteError(err, what);
    }
  };

  let created: string | null = null;
  if (change.secret) {
    const secretName = change.secret.metadata.name;
    let existing: any = null;
    try {
      existing = await request(`/api/v1/namespaces/${namespace}/secrets/${secretName}`);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    if (existing && !isOwnIngressSecret(existing, name)) {
      throw new Error(
        `Secret ${namespace}/${secretName} already exists and was not created for this Ingress.`
      );
    }
    const inUse =
      localSecretName(ingress.metadata.annotations?.[ANN.authSecret], namespace) === secretName;
    if (existing && inUse) {
      if (hasPatch) await patch();
      try {
        await updateResource(existing, change.secret);
      } catch (err) {
        throw new Error(
          `${
            hasPatch ? 'The annotations were saved, but ' : ''
          }the new password could not be written: ${errText(err)}`
        );
      }
      return;
    }
    if (existing) {
      await updateResource(existing, change.secret);
    } else {
      await createResource(change.secret);
      created = secretName;
    }
  }

  if (hasPatch) {
    try {
      await patch();
    } catch (err) {
      if (created) {
        let pointsAtIt = true;
        try {
          const fresh: any = await request(
            `/apis/networking.k8s.io/v1/namespaces/${namespace}/ingresses/${name}`
          );
          pointsAtIt =
            localSecretName(fresh?.metadata?.annotations?.[ANN.authSecret], namespace) === created;
        } catch {
          // Unreadable: keep the Secret. An unused Secret is harmless; a missing one is not.
        }
        if (!pointsAtIt) await deleteResource('v1', 'Secret', created, namespace).catch(() => {});
      }
      throw err;
    }
  }

  if (change.dropSecret) {
    await deleteIfLabelled(
      'v1',
      'Secret',
      change.dropSecret,
      { [MANAGED_BY_LABEL]: CLICK_OPS_MANAGED_BY, [FOR_INGRESS_LABEL]: name },
      namespace
    );
  }
}
