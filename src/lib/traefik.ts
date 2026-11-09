import { request } from '@kinvolk/headlamp-plugin/lib/ApiProxy';
import {
  applyResources,
  createResource,
  deleteResource,
  isConflict,
  isNotFound,
  patchResource,
  updateResource,
} from './apply';
import { encodeUtf8ToBase64, tryDecodeBase64ToUtf8 } from './kvResources';
import { MANAGED_BY_LABEL } from './rbac';

/**
 * Traefik v3 CRDs (`traefik.io/v1alpha1`) without YAML: Middlewares built from a form and
 * attached to Ingresses or IngressRoutes. The v2 group `traefik.containo.us` is gone in v3
 * and is deliberately not supported.
 */

export const TRAEFIK_GROUP_VERSION = 'traefik.io/v1alpha1';
const TRAEFIK_API = `/apis/${TRAEFIK_GROUP_VERSION}`;
const TRAEFIK_V2_API = '/apis/traefik.containo.us/v1alpha1';
const NETWORKING_API = '/apis/networking.k8s.io/v1';

/**
 * Not the access-builder value: orphans.ts treats everything carrying that one as part of
 * an account, and a Middleware belongs to none.
 */
export const CLICK_OPS_MANAGED_BY = 'headlamp-click-ops';
export const FOR_MIDDLEWARE_LABEL = 'click-ops/for-middleware';

export const ROUTER_MIDDLEWARES_ANNOTATION = 'traefik.ingress.kubernetes.io/router.middlewares';
export const ROUTER_ACCESSLOGS_ANNOTATION =
  'traefik.ingress.kubernetes.io/router.observability.accesslogs';
export const TRAEFIK_INGRESS_CONTROLLER = 'traefik.io/ingress-controller';
const DEFAULT_CLASS_ANNOTATION = 'ingressclass.kubernetes.io/is-default-class';
export const LEGACY_CLASS_ANNOTATION = 'kubernetes.io/ingress.class';
const CRD_PROVIDER_SUFFIX = '@kubernetescrd';

type AnyMap = Record<string, any>;

export type ObjectMeta = {
  name: string;
  namespace: string;
  resourceVersion?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
};

export type MiddlewareObject = { metadata: ObjectMeta; spec?: AnyMap };

export type IngressObject = {
  metadata: ObjectMeta;
  spec?: {
    ingressClassName?: string;
    rules?: { host?: string; http?: { paths?: { path?: string }[] } }[];
    tls?: { hosts?: string[]; secretName?: string }[];
  };
};

export type MiddlewareRef = { name: string; namespace?: string; [k: string]: any };

export type IngressRouteRoute = {
  match?: string;
  middlewares?: MiddlewareRef[];
  observability?: AnyMap;
  [k: string]: any;
};

export type IngressRouteObject = {
  metadata: ObjectMeta;
  spec?: { entryPoints?: string[]; routes?: IngressRouteRoute[]; [k: string]: any };
};

export type IngressClassInfo = { name: string; controller: string; isDefault: boolean };

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Middleware types the form understands
// ---------------------------------------------------------------------------

export type MiddlewareType =
  | 'ipAllowList'
  | 'basicAuth'
  | 'redirectScheme'
  | 'headers'
  | 'rateLimit'
  | 'stripPrefix';

export const MIDDLEWARE_TYPES: {
  type: MiddlewareType;
  label: string;
  description: string;
  icon: string;
}[] = [
  {
    type: 'ipAllowList',
    label: 'IP allowlist',
    description: 'Only let in requests from the addresses or networks you list.',
    icon: 'mdi:shield-check-outline',
  },
  {
    type: 'basicAuth',
    label: 'Login (basic auth)',
    description: 'Ask for a username and password before the app is reached.',
    icon: 'mdi:account-lock-outline',
  },
  {
    type: 'redirectScheme',
    label: 'Redirect to HTTPS',
    description: 'Send plain-HTTP visitors to the HTTPS address.',
    icon: 'mdi:lock-outline',
  },
  {
    type: 'headers',
    label: 'Security headers',
    description: 'HSTS, clickjacking and MIME-sniffing protection, custom headers.',
    icon: 'mdi:shield-half-full',
  },
  {
    type: 'rateLimit',
    label: 'Rate limit',
    description: 'Cap how many requests one client may send.',
    icon: 'mdi:speedometer-slow',
  },
  {
    type: 'stripPrefix',
    label: 'Strip path prefix',
    description: 'Remove a path prefix such as /api before the request reaches the app.',
    icon: 'mdi:content-cut',
  },
];

const SUPPORTED_TYPES = new Set<string>(MIDDLEWARE_TYPES.map(t => t.type));

export function typeLabel(type: MiddlewareType | 'other'): string {
  return MIDDLEWARE_TYPES.find(t => t.type === type)?.label ?? 'Other';
}

/** The keys set under `spec`, e.g. `['ipAllowList']`, or `['chain']` for a foreign one. */
export function specKinds(spec: AnyMap | undefined): string[] {
  if (!spec || typeof spec !== 'object') return [];
  return Object.keys(spec).filter(k => spec[k] !== undefined && spec[k] !== null);
}

/** A supported type only when it is the single thing the middleware does. */
export function detectType(spec: AnyMap | undefined): MiddlewareType | 'other' {
  const kinds = specKinds(spec);
  if (kinds.length === 1 && SUPPORTED_TYPES.has(kinds[0])) return kinds[0] as MiddlewareType;
  return 'other';
}

/**
 * Whether the form can edit this middleware without losing meaning. A redirectScheme that
 * sends traffic somewhere other than https would be rewritten by a form that fixes https.
 */
export function isFormEditable(mw: MiddlewareObject): boolean {
  const type = detectType(mw.spec);
  if (type === 'other') return false;
  if (type === 'redirectScheme') {
    const scheme = mw.spec?.redirectScheme?.scheme;
    return scheme === undefined || scheme === 'https';
  }
  return true;
}

export function isClickOpsManaged(obj: {
  metadata?: { labels?: Record<string, string> };
}): boolean {
  return obj?.metadata?.labels?.[MANAGED_BY_LABEL] === CLICK_OPS_MANAGED_BY;
}

function listPreview(values: string[], max = 3): string {
  const shown = values.slice(0, max).join(', ');
  return values.length > max ? `${shown} +${values.length - max} more` : shown;
}

function asStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [];
}

export function summarizeMiddleware(mw: MiddlewareObject): string {
  const type = detectType(mw.spec);
  const s: AnyMap = type === 'other' ? {} : mw.spec?.[type] ?? {};
  switch (type) {
    case 'ipAllowList': {
      const ranges = asStringList(s.sourceRange);
      const depth = s.ipStrategy?.depth;
      return (
        `allow ${ranges.length === 0 ? 'nothing' : listPreview(ranges)}` +
        (typeof depth === 'number' ? ` (behind proxy, depth ${depth})` : '')
      );
    }
    case 'basicAuth':
      return `login checked against Secret ${s.secret ?? '(none)'}`;
    case 'redirectScheme':
      return `redirect to ${s.scheme ?? 'https'}${s.permanent ? ' (permanent)' : ''}`;
    case 'headers': {
      const parts: string[] = [];
      if (typeof s.stsSeconds === 'number' && s.stsSeconds > 0) parts.push(`HSTS ${s.stsSeconds}s`);
      if (s.frameDeny) parts.push('frame deny');
      if (s.contentTypeNosniff) parts.push('nosniff');
      if (s.referrerPolicy) parts.push(`referrer ${s.referrerPolicy}`);
      const custom =
        Object.keys(s.customRequestHeaders ?? {}).length +
        Object.keys(s.customResponseHeaders ?? {}).length;
      if (custom > 0) parts.push(`${custom} custom header${custom === 1 ? '' : 's'}`);
      return parts.length > 0 ? parts.join(', ') : 'headers';
    }
    case 'rateLimit':
      return `${s.average ?? '?'} requests per ${s.period ?? '1s'}${
        s.burst !== undefined ? `, burst ${s.burst}` : ''
      }`;
    case 'stripPrefix':
      return `strip ${listPreview(asStringList(s.prefixes))}`;
    default: {
      const kinds = specKinds(mw.spec);
      return kinds.length > 0 ? kinds.join(' + ') : 'empty';
    }
  }
}

// ---------------------------------------------------------------------------
// Form state and its conversion to and from spec
// ---------------------------------------------------------------------------

export type HeaderEntry = { key: string; value: string };

export type IpAllowListForm = {
  sourceRange: string[];
  behindProxy: boolean;
  depth: number;
  /** Empty means Traefik's default, 403. */
  rejectStatusCode: string;
};

export type BasicAuthForm = {
  username: string;
  /** On edit, empty means "leave the stored credentials alone". */
  password: string;
  realm: string;
  removeHeader: boolean;
  /** The Secret the live middleware points at; empty on create. */
  secretName: string;
  /** Whether that Secret was created by this page, so the form may rewrite it. */
  credentialsManaged: boolean;
  /** The username currently stored in the managed Secret. */
  existingUsername: string | null;
};

export type RedirectSchemeForm = { permanent: boolean; port: string };

export type HeadersForm = {
  stsSeconds: number;
  stsIncludeSubdomains: boolean;
  stsPreload: boolean;
  frameDeny: boolean;
  contentTypeNosniff: boolean;
  referrerPolicy: string;
  customRequestHeaders: HeaderEntry[];
  customResponseHeaders: HeaderEntry[];
};

export type RateLimitForm = { average: string; period: string; burst: string };

export type StripPrefixForm = { prefixes: string[] };

export type MiddlewareForm = {
  name: string;
  namespace: string;
  type: MiddlewareType;
  ipAllowList: IpAllowListForm;
  basicAuth: BasicAuthForm;
  redirectScheme: RedirectSchemeForm;
  headers: HeadersForm;
  rateLimit: RateLimitForm;
  stripPrefix: StripPrefixForm;
};

export const HSTS_OPTIONS: { seconds: number; label: string }[] = [
  { seconds: 0, label: 'Off' },
  { seconds: 86400, label: '1 day (try it out)' },
  { seconds: 15552000, label: '6 months' },
  { seconds: 31536000, label: '1 year (recommended)' },
];

export const REFERRER_POLICIES = [
  'no-referrer',
  'no-referrer-when-downgrade',
  'origin',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
];

export const RATE_PERIODS: { value: string; label: string }[] = [
  { value: '1s', label: 'per second' },
  { value: '1m', label: 'per minute' },
  { value: '1h', label: 'per hour' },
];

export const PRIVATE_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];
export const LOCALHOST_RANGES = ['127.0.0.1/32', '::1/128'];

export function emptyForm(namespace: string): MiddlewareForm {
  return {
    name: '',
    namespace,
    type: 'ipAllowList',
    ipAllowList: { sourceRange: [], behindProxy: false, depth: 1, rejectStatusCode: '' },
    basicAuth: {
      username: '',
      password: '',
      realm: '',
      removeHeader: true,
      secretName: '',
      credentialsManaged: false,
      existingUsername: null,
    },
    redirectScheme: { permanent: true, port: '' },
    headers: {
      stsSeconds: 31536000,
      stsIncludeSubdomains: true,
      stsPreload: false,
      frameDeny: true,
      contentTypeNosniff: true,
      referrerPolicy: 'strict-origin-when-cross-origin',
      customRequestHeaders: [],
      customResponseHeaders: [],
    },
    rateLimit: { average: '100', period: '1s', burst: '100' },
    stripPrefix: { prefixes: [] },
  };
}

function mapToEntries(m: unknown): HeaderEntry[] {
  if (!m || typeof m !== 'object') return [];
  return Object.entries(m as AnyMap).map(([key, value]) => ({ key, value: String(value ?? '') }));
}

function entriesToMap(entries: HeaderEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries) {
    const key = e.key.trim();
    if (key) out[key] = e.value;
  }
  return out;
}

function cleanList(values: string[]): string[] {
  return values.map(v => v.trim()).filter(v => v.length > 0);
}

/** The form for an existing middleware. Basic-auth credentials are resolved separately. */
export function formFromMiddleware(mw: MiddlewareObject): MiddlewareForm {
  const form = emptyForm(mw.metadata.namespace);
  form.name = mw.metadata.name;
  const type = detectType(mw.spec);
  if (type === 'other') return form;
  form.type = type;
  const s: AnyMap = mw.spec?.[type] ?? {};
  switch (type) {
    case 'ipAllowList':
      form.ipAllowList = {
        sourceRange: asStringList(s.sourceRange),
        behindProxy: typeof s.ipStrategy?.depth === 'number',
        depth: typeof s.ipStrategy?.depth === 'number' ? s.ipStrategy.depth : 1,
        rejectStatusCode: s.rejectStatusCode !== undefined ? String(s.rejectStatusCode) : '',
      };
      break;
    case 'basicAuth':
      form.basicAuth = {
        ...form.basicAuth,
        secretName: typeof s.secret === 'string' ? s.secret : '',
        realm: typeof s.realm === 'string' ? s.realm : '',
        removeHeader: s.removeHeader === true,
      };
      break;
    case 'redirectScheme':
      form.redirectScheme = {
        permanent: s.permanent === true,
        port: s.port !== undefined && s.port !== null ? String(s.port) : '',
      };
      break;
    case 'headers':
      form.headers = {
        stsSeconds: typeof s.stsSeconds === 'number' ? s.stsSeconds : 0,
        stsIncludeSubdomains: s.stsIncludeSubdomains === true,
        stsPreload: s.stsPreload === true,
        frameDeny: s.frameDeny === true,
        contentTypeNosniff: s.contentTypeNosniff === true,
        referrerPolicy: typeof s.referrerPolicy === 'string' ? s.referrerPolicy : '',
        customRequestHeaders: mapToEntries(s.customRequestHeaders),
        customResponseHeaders: mapToEntries(s.customResponseHeaders),
      };
      break;
    case 'rateLimit':
      form.rateLimit = {
        average: s.average !== undefined ? String(s.average) : '',
        period: s.period !== undefined ? String(s.period) : '1s',
        burst: s.burst !== undefined ? String(s.burst) : '',
      };
      break;
    case 'stripPrefix':
      form.stripPrefix = { prefixes: asStringList(s.prefixes) };
      break;
  }
  return form;
}

function setOrDelete(target: AnyMap, key: string, value: unknown, keep: boolean): void {
  if (keep) target[key] = value;
  else delete target[key];
}

export function basicAuthSecretName(middlewareName: string): string {
  return `${middlewareName}-basic-auth`;
}

/**
 * The `spec.<type>` object to send.
 *
 * Built on top of the live object rather than from the form alone: the PUT replaces `spec`
 * wholesale, so anything the form does not render (`contentSecurityPolicy`,
 * `ipStrategy.excludedIPs`, a rateLimit `sourceCriterion`...) would otherwise be dropped
 * without a word. Only the fields the form owns are set or deleted here.
 */
export function buildTypeSpec(form: MiddlewareForm, liveTypeSpec?: unknown): AnyMap {
  const base: AnyMap =
    liveTypeSpec && typeof liveTypeSpec === 'object'
      ? JSON.parse(JSON.stringify(liveTypeSpec))
      : {};

  switch (form.type) {
    case 'ipAllowList': {
      const f = form.ipAllowList;
      base.sourceRange = cleanList(f.sourceRange);
      const strategy: AnyMap = { ...(base.ipStrategy ?? {}) };
      setOrDelete(strategy, 'depth', f.depth, f.behindProxy);
      setOrDelete(base, 'ipStrategy', strategy, Object.keys(strategy).length > 0);
      const code = f.rejectStatusCode.trim();
      setOrDelete(base, 'rejectStatusCode', Number(code), code !== '');
      return base;
    }
    case 'basicAuth': {
      const f = form.basicAuth;
      base.secret = f.secretName || basicAuthSecretName(form.name);
      const realm = f.realm.trim();
      setOrDelete(base, 'realm', realm, realm !== '');
      setOrDelete(base, 'removeHeader', true, f.removeHeader);
      return base;
    }
    case 'redirectScheme': {
      const f = form.redirectScheme;
      base.scheme = 'https';
      setOrDelete(base, 'permanent', true, f.permanent);
      const port = f.port.trim();
      setOrDelete(base, 'port', port, port !== '');
      return base;
    }
    case 'headers': {
      const f = form.headers;
      // includeSubdomains and preload only mean something alongside an HSTS max-age.
      const hsts = f.stsSeconds > 0;
      setOrDelete(base, 'stsSeconds', f.stsSeconds, hsts);
      setOrDelete(base, 'stsIncludeSubdomains', true, hsts && f.stsIncludeSubdomains);
      setOrDelete(base, 'stsPreload', true, hsts && f.stsPreload);
      setOrDelete(base, 'frameDeny', true, f.frameDeny);
      setOrDelete(base, 'contentTypeNosniff', true, f.contentTypeNosniff);
      setOrDelete(base, 'referrerPolicy', f.referrerPolicy, f.referrerPolicy !== '');
      const req = entriesToMap(f.customRequestHeaders);
      setOrDelete(base, 'customRequestHeaders', req, Object.keys(req).length > 0);
      const res = entriesToMap(f.customResponseHeaders);
      setOrDelete(base, 'customResponseHeaders', res, Object.keys(res).length > 0);
      return base;
    }
    case 'rateLimit': {
      const f = form.rateLimit;
      base.average = Number(f.average);
      // `period` may be a number on the live object; leave it as it was unless changed.
      if (base.period === undefined || String(base.period) !== f.period) base.period = f.period;
      const burst = f.burst.trim();
      setOrDelete(base, 'burst', Number(burst), burst !== '');
      return base;
    }
    case 'stripPrefix':
      base.prefixes = cleanList(form.stripPrefix.prefixes);
      return base;
  }
}

/**
 * The Middleware manifest. The managed-by label goes on new objects only: stamping it onto
 * an existing one would overwrite `managed-by: Helm` and break the next `helm upgrade`.
 */
export function buildMiddleware(form: MiddlewareForm, live?: MiddlewareObject | null) {
  return {
    apiVersion: TRAEFIK_GROUP_VERSION,
    kind: 'Middleware',
    metadata: {
      name: form.name,
      namespace: form.namespace,
      ...(live ? {} : { labels: { [MANAGED_BY_LABEL]: CLICK_OPS_MANAGED_BY } }),
    },
    spec: { [form.type]: buildTypeSpec(form, live?.spec?.[form.type]) },
  };
}

/** Traefik reads `username` and `password` from a Secret of this type as they are. */
export function buildBasicAuthSecret(
  middlewareName: string,
  namespace: string,
  secretName: string,
  username: string,
  password: string
) {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: secretName,
      namespace,
      labels: {
        [MANAGED_BY_LABEL]: CLICK_OPS_MANAGED_BY,
        [FOR_MIDDLEWARE_LABEL]: middlewareName,
      },
    },
    type: 'kubernetes.io/basic-auth',
    data: {
      username: encodeUtf8ToBase64(username),
      password: encodeUtf8ToBase64(password),
    },
  };
}

export function isOwnBasicAuthSecret(secret: AnyMap | null, middlewareName: string): boolean {
  const labels = secret?.metadata?.labels ?? {};
  return (
    labels[MANAGED_BY_LABEL] === CLICK_OPS_MANAGED_BY &&
    labels[FOR_MIDDLEWARE_LABEL] === middlewareName
  );
}

/** Creating always writes credentials; an edit only when a new password was typed. */
export function shouldWriteBasicAuthSecret(form: MiddlewareForm, creating: boolean): boolean {
  if (form.type !== 'basicAuth') return false;
  if (creating) return true;
  return form.basicAuth.credentialsManaged && form.basicAuth.password !== '';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Leading zeros are rejected: Go's net.ParseIP and ParseCIDR refuse `010.0.0.1` since 1.17,
 * so Traefik would fail on an address this check had let through.
 */
const DECIMAL_NO_LEADING_ZERO = /^(0|[1-9]\d{0,2})$/;

function isIPv4(s: string): boolean {
  const parts = s.split('.');
  return (
    parts.length === 4 && parts.every(p => DECIMAL_NO_LEADING_ZERO.test(p) && Number(p) <= 255)
  );
}

function isIPv6(s: string): boolean {
  if (!s.includes(':')) return false;
  let head = s;
  let embeddedGroups = 0;
  // An embedded IPv4 tail (::ffff:10.0.0.1) counts as two groups.
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (!isIPv4(tail)) return false;
    embeddedGroups = 2;
    head = s.slice(0, lastColon + 1);
    if (!head.endsWith('::')) head = head.slice(0, -1);
  }
  const halves = head.split('::');
  if (halves.length > 2) return false;
  const hex = /^[0-9a-fA-F]{1,4}$/;
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  if (halves.length === 2) {
    const all = [...groups(halves[0]), ...groups(halves[1])];
    // "::" stands for at least one group of zeros.
    return all.every(g => hex.test(g)) && all.length + embeddedGroups <= 7;
  }
  const all = groups(head);
  return all.every(g => hex.test(g)) && all.length + embeddedGroups === 8;
}

/** An IPv4 or IPv6 address, optionally with a CIDR prefix length. */
export function isValidSourceRange(raw: string): boolean {
  const s = raw.trim();
  const slash = s.indexOf('/');
  const ip = slash === -1 ? s : s.slice(0, slash);
  const prefix = slash === -1 ? null : s.slice(slash + 1);
  const v4 = isIPv4(ip);
  if (!v4 && !isIPv6(ip)) return false;
  if (prefix === null) return true;
  if (!DECIMAL_NO_LEADING_ZERO.test(prefix)) return false;
  return Number(prefix) <= (v4 ? 32 : 128);
}

/** DNS-1123 label: what Kubernetes accepts as a Middleware name. */
export function isValidResourceName(name: string): boolean {
  return name.length <= 63 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name);
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
/** A header value may hold a tab but no other control character — above all no CR or LF. */
// eslint-disable-next-line no-control-regex
const HEADER_VALUE_FORBIDDEN = /[\x00-\x08\x0a-\x1f\x7f]/;

export function isValidHeaderValue(value: string): boolean {
  return !HEADER_VALUE_FORBIDDEN.test(value);
}

function isWholeNumber(v: string, min: number, max = Number.MAX_SAFE_INTEGER): boolean {
  if (!/^\d+$/.test(v.trim())) return false;
  const n = Number(v);
  return n >= min && n <= max;
}

export function validateMiddlewareForm(
  form: MiddlewareForm,
  creating: boolean,
  liveTypeSpec?: unknown
): string[] {
  const errors: string[] = [];
  if (!form.namespace) errors.push('Namespace is required.');
  // Only a new name is checked: an existing `my.mw` is a valid DNS subdomain the field can no
  // longer change, and failing it here would make that middleware uneditable.
  if (creating) {
    if (!form.name) errors.push('Name is required.');
    else if (!isValidResourceName(form.name)) {
      errors.push(
        'Name must be lowercase letters, digits and "-", start and end with a letter or digit, at most 63 characters.'
      );
    }
  }

  switch (form.type) {
    case 'ipAllowList': {
      const f = form.ipAllowList;
      const ranges = cleanList(f.sourceRange);
      if (ranges.length === 0) errors.push('Add at least one IP address or network.');
      for (const r of ranges) {
        if (!isValidSourceRange(r)) errors.push(`"${r}" is not an IP address or CIDR network.`);
      }
      if (f.behindProxy && !(Number.isInteger(f.depth) && f.depth >= 1)) {
        errors.push('Proxy depth must be a whole number of at least 1.');
      }
      if (f.rejectStatusCode.trim() !== '' && !isWholeNumber(f.rejectStatusCode, 100, 599)) {
        errors.push('Reject status code must be an HTTP status between 100 and 599.');
      }
      break;
    }
    case 'basicAuth': {
      const f = form.basicAuth;
      if (f.username.includes(':')) errors.push('The username cannot contain ":".');
      if (creating) {
        if (!f.username) errors.push('Username is required.');
        if (!f.password) errors.push('Password is required.');
      } else if (f.credentialsManaged) {
        if (f.password && !f.username) errors.push('Username is required.');
        if (!f.password && f.username !== (f.existingUsername ?? '')) {
          errors.push('Changing the username needs a password as well.');
        }
      }
      break;
    }
    case 'redirectScheme': {
      const port = form.redirectScheme.port.trim();
      if (port !== '' && !isWholeNumber(port, 1, 65535)) {
        errors.push('Port must be a number between 1 and 65535.');
      }
      break;
    }
    case 'headers': {
      const f = form.headers;
      for (const e of [...f.customRequestHeaders, ...f.customResponseHeaders]) {
        const key = e.key.trim();
        if (key && !HEADER_NAME.test(key)) errors.push(`"${key}" is not a valid header name.`);
        if (key && !isValidHeaderValue(e.value)) {
          errors.push(`The value of "${key}" contains a line break or another control character.`);
        }
      }
      if (Object.keys(buildTypeSpec(form, liveTypeSpec)).length === 0) {
        errors.push('Turn on at least one header option.');
      }
      break;
    }
    case 'rateLimit': {
      const f = form.rateLimit;
      if (!isWholeNumber(f.average, 1)) errors.push('Average must be a whole number above 0.');
      if (f.burst.trim() !== '' && !isWholeNumber(f.burst, 1)) {
        errors.push('Burst must be a whole number above 0.');
      }
      if (!f.period.trim()) errors.push('Pick a period.');
      break;
    }
    case 'stripPrefix': {
      const prefixes = cleanList(form.stripPrefix.prefixes);
      if (prefixes.length === 0) errors.push('Add at least one prefix.');
      for (const p of prefixes) {
        if (!p.startsWith('/')) errors.push(`Prefix "${p}" must start with "/".`);
      }
      break;
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Attaching middlewares: Ingress annotation and IngressRoute routes
// ---------------------------------------------------------------------------

export type TriState = 'default' | 'on' | 'off';

export function middlewareRef(namespace: string, name: string): string {
  return `${namespace}-${name}${CRD_PROVIDER_SUFFIX}`;
}

export function parseMiddlewareRefs(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/** Names of the given middlewares that the annotation value references. */
export function attachedIngressMiddlewares(
  annotationValue: string | undefined,
  namespace: string,
  knownNames: string[]
): string[] {
  const refs = new Set(parseMiddlewareRefs(annotationValue));
  return knownNames.filter(n => refs.has(middlewareRef(namespace, n)));
}

/**
 * The new annotation value, or null to remove it.
 *
 * Entries the dialog does not manage (`auth@file`, a middleware from another namespace)
 * stay where they were. Managed entries that remain selected also keep their position,
 * because the order is the order Traefik runs them in; newly selected ones go last.
 */
export function setIngressMiddlewares(
  currentValue: string | undefined,
  namespace: string,
  knownNames: string[],
  selected: string[]
): string | null {
  const managedRefs = new Map(knownNames.map(n => [middlewareRef(namespace, n), n]));
  const selectedSet = new Set(selected);
  const result: string[] = [];
  const present = new Set<string>();
  for (const ref of parseMiddlewareRefs(currentValue)) {
    const name = managedRefs.get(ref);
    if (name === undefined) {
      result.push(ref);
    } else if (selectedSet.has(name) && !present.has(name)) {
      result.push(ref);
      present.add(name);
    }
  }
  for (const name of knownNames) {
    if (selectedSet.has(name) && !present.has(name)) {
      result.push(middlewareRef(namespace, name));
      present.add(name);
    }
  }
  return result.length > 0 ? result.join(',') : null;
}

export function parseAccessLogsAnnotation(value: string | undefined): TriState {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'true') return 'on';
  if (v === 'false') return 'off';
  return 'default';
}

function triStateToAnnotation(state: TriState): string | null {
  if (state === 'on') return 'true';
  if (state === 'off') return 'false';
  return null;
}

/**
 * Merge patch for an Ingress. `null` deletes an annotation; the resourceVersion makes the
 * patch fail with 409 instead of overwriting a change made since the list was read.
 *
 * The access-log annotation is only touched when the switch was actually moved: a value
 * this page reads as "default" without it being absent (`"1"`, `"t"`) would otherwise be
 * deleted by an edit that only changed middlewares.
 */
export function buildIngressPatch(
  ingress: IngressObject,
  knownNames: string[],
  selected: string[],
  accessLogs: TriState,
  /** A section the running Traefik does not read is left out of the patch entirely. */
  writable: { middlewares: boolean; accessLogs: boolean } = { middlewares: true, accessLogs: true }
) {
  const annotations = ingress.metadata.annotations ?? {};
  const accessLogsChanged =
    accessLogs !== parseAccessLogsAnnotation(annotations[ROUTER_ACCESSLOGS_ANNOTATION]);
  return {
    metadata: {
      resourceVersion: ingress.metadata.resourceVersion,
      annotations: {
        ...(writable.middlewares
          ? {
              [ROUTER_MIDDLEWARES_ANNOTATION]: setIngressMiddlewares(
                annotations[ROUTER_MIDDLEWARES_ANNOTATION],
                ingress.metadata.namespace,
                knownNames,
                selected
              ),
            }
          : {}),
        ...(writable.accessLogs && accessLogsChanged
          ? { [ROUTER_ACCESSLOGS_ANNOTATION]: triStateToAnnotation(accessLogs) }
          : {}),
      },
    },
  };
}

function refPointsAt(ref: MiddlewareRef, routeNamespace: string, mwNamespace: string): boolean {
  return (ref.namespace || routeNamespace) === mwNamespace;
}

/** Names of the given same-namespace middlewares this route references. */
export function attachedRouteMiddlewares(
  route: IngressRouteRoute,
  namespace: string,
  knownNames: string[]
): string[] {
  const names = new Set(
    (route.middlewares ?? [])
      .filter(ref => refPointsAt(ref, namespace, namespace))
      .map(ref => ref.name)
  );
  return knownNames.filter(n => names.has(n));
}

export function routeAccessLogs(route: IngressRouteRoute): TriState {
  const v = route.observability?.accessLogs;
  if (v === true) return 'on';
  if (v === false) return 'off';
  return 'default';
}

export type RouteEdit = { selected: string[]; accessLogs: TriState };

/**
 * One route with its middleware list and access-log switch replaced. References to other
 * namespaces, middlewares this page did not list, and every other observability field
 * (`metrics`, `tracing`, `traceVerbosity`) stay as they were.
 */
export function editRoute(
  route: IngressRouteRoute,
  namespace: string,
  knownNames: string[],
  edit: RouteEdit
): IngressRouteRoute {
  const next: IngressRouteRoute = JSON.parse(JSON.stringify(route));
  const known = new Set(knownNames);
  const selected = new Set(edit.selected);
  const kept: MiddlewareRef[] = [];
  const present = new Set<string>();
  for (const ref of route.middlewares ?? []) {
    const managed = refPointsAt(ref, namespace, namespace) && known.has(ref.name);
    if (!managed) {
      kept.push(ref);
    } else if (selected.has(ref.name) && !present.has(ref.name)) {
      kept.push(ref);
      present.add(ref.name);
    }
  }
  for (const name of knownNames) {
    if (selected.has(name) && !present.has(name)) {
      kept.push({ name });
      present.add(name);
    }
  }
  setOrDelete(next, 'middlewares', kept, kept.length > 0);

  const observability: AnyMap = { ...(route.observability ?? {}) };
  setOrDelete(observability, 'accessLogs', edit.accessLogs === 'on', edit.accessLogs !== 'default');
  setOrDelete(next, 'observability', observability, Object.keys(observability).length > 0);
  return next;
}

/**
 * Whether the API server dropped an access-log setting we sent. A CRD from before
 * per-router observability prunes the unknown field silently, so a 200 proves nothing.
 */
export function observabilityDropped(
  sent: IngressRouteRoute[],
  live: IngressRouteRoute[]
): boolean {
  return sent.some((route, i) => {
    const wanted = route.observability?.accessLogs;
    if (typeof wanted !== 'boolean') return false;
    return live[i]?.observability?.accessLogs !== wanted;
  });
}

/**
 * Fields under `spec.<type>` that were sent but are missing from what the API server stored.
 *
 * A CRD prunes fields it does not know without an error. Traefik v2.10/2.11 already serve
 * traefik.io/v1alpha1 but know `ipWhiteList`, not `ipAllowList`, and older v3 CRDs lack some
 * newer fields — in both cases a 2xx proves nothing. `[]` when the stored object cannot tell.
 */
export function prunedTypeFields(type: string, sentTypeSpec: AnyMap, stored: unknown): string[] {
  const obj = stored as AnyMap | null;
  if (!obj || typeof obj !== 'object' || !obj.metadata) return [];
  const storedTypeSpec = obj.spec?.[type];
  if (storedTypeSpec === undefined || storedTypeSpec === null) return [`spec.${type}`];
  return Object.keys(sentTypeSpec)
    .filter(k => sentTypeSpec[k] !== undefined && storedTypeSpec[k] === undefined)
    .map(k => `spec.${type}.${k}`);
}

export type IngressClassResolution = {
  className: string | null;
  controller: string | null;
  /** null when it cannot be told, e.g. no IngressClass object for the name. */
  handledByTraefik: boolean | null;
};

export function resolveIngressClass(
  ingress: IngressObject,
  classes: IngressClassInfo[]
): IngressClassResolution {
  const explicit =
    ingress.spec?.ingressClassName ??
    ingress.metadata.annotations?.[LEGACY_CLASS_ANNOTATION] ??
    null;
  const name = explicit ?? classes.find(c => c.isDefault)?.name ?? null;
  if (!name) return { className: null, controller: null, handledByTraefik: null };
  const cls = classes.find(c => c.name === name);
  if (!cls) return { className: name, controller: null, handledByTraefik: null };
  return {
    className: name,
    controller: cls.controller,
    handledByTraefik: cls.controller === TRAEFIK_INGRESS_CONTROLLER,
  };
}

// ---------------------------------------------------------------------------
// What the running Traefik actually reads
// ---------------------------------------------------------------------------
//
// A Middleware and a `router.middlewares` annotation prove nothing on their own. Traefik
// reads Middleware objects only through its kubernetesCRD provider and that annotation only
// through its native kubernetesIngress provider. Installs that replaced ingress-nginx often
// run just the kubernetesIngressNGINX compatibility provider, which enforces
// `nginx.ingress.kubernetes.io/*` annotations instead — there an attached middleware looks
// like protection while nothing enforces it. So the providers are read off the Traefik
// workload's arguments, and anything the page cannot establish is reported as unknown
// rather than guessed.

export type ProviderState = 'on' | 'off' | 'unknown';

export type NginxProviderOptions = {
  controllerClass: string;
  ingressClass: string;
  ingressClassByName: boolean;
  watchIngressWithoutClass: boolean;
};

/** Traefik's documented defaults for the kubernetesIngressNGINX provider. */
export const NGINX_PROVIDER_DEFAULTS: NginxProviderOptions = {
  controllerClass: 'k8s.io/ingress-nginx',
  ingressClass: 'nginx',
  ingressClassByName: false,
  watchIngressWithoutClass: false,
};

export type TraefikProviders = {
  kubernetesCRD: ProviderState;
  kubernetesIngress: ProviderState;
  kubernetesIngressNGINX: ProviderState;
};

export type WorkloadKind = 'DaemonSet' | 'Deployment' | 'StatefulSet';

export type TraefikWorkload = {
  kind: WorkloadKind;
  namespace: string;
  name: string;
  image: string;
  args: string[];
  /** Where the container mounts volumes — a mounted traefik.yml overrides the arguments. */
  mountPaths: string[];
};

export type TraefikVersion = { major: number; minor: number; patch: number };

export type TraefikRuntime =
  | { status: 'unknown'; reason: string }
  | {
      status: 'known';
      /** "DaemonSet traefik/traefik" */
      source: string;
      image: string;
      /** From the image tag; null for `latest`, a digest, or a Hub/Enterprise image. */
      version: TraefikVersion | null;
      providers: TraefikProviders;
      nginx: NginxProviderOptions;
      /**
       * Options that narrow which Ingresses a provider takes (namespaces, selectors, the native
       * provider's ingressClass). Not evaluated here, so a provider with any of them set makes
       * its Ingresses "unknown".
       */
      scoped: { kubernetesIngress: boolean; kubernetesIngressNGINX: boolean };
      accessLogs: ProviderState;
    };

function imageRepoAndTag(image: string): { repo: string; tag: string | null } {
  const withoutDigest = image.split('@')[0];
  const lastSegment = withoutDigest.split('/').pop() ?? '';
  const [repo, tag] = lastSegment.split(':');
  return { repo, tag: tag ?? null };
}

/**
 * `traefik:v3.7`, `docker.io/traefik:v3.7.17`, k3s's `rancher/mirrored-library-traefik:3.3`,
 * and Traefik Hub / Enterprise, which count as another Traefik even though their versions are
 * not the proxy's.
 */
export function isTraefikImage(image: string): boolean {
  return /(^|-)traefik(ee|-hub)?$/.test(imageRepoAndTag(image).repo);
}

/** The proxy version from the image tag; null when the tag does not say (or for Hub/EE). */
export function traefikVersionOf(image: string): TraefikVersion | null {
  const { repo, tag } = imageRepoAndTag(image);
  if (!/(^|-)traefik$/.test(repo) || !tag) return null;
  const m = tag.match(/^v?(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0) };
}

export function atLeastVersion(v: TraefikVersion, major: number, minor: number): boolean {
  return v.major > major || (v.major === major && v.minor >= minor);
}

/** The Traefik containers among DaemonSets, Deployments and StatefulSets, one per container. */
export function findTraefikWorkloads(
  objects: { kind: WorkloadKind; items: AnyMap[] }[]
): TraefikWorkload[] {
  const found: TraefikWorkload[] = [];
  for (const { kind, items } of objects) {
    for (const obj of items) {
      for (const c of obj?.spec?.template?.spec?.containers ?? []) {
        if (typeof c?.image !== 'string' || !isTraefikImage(c.image)) continue;
        found.push({
          kind,
          namespace: obj.metadata?.namespace ?? '',
          name: obj.metadata?.name ?? '',
          image: c.image,
          args: Array.isArray(c.args) ? c.args.map(String) : [],
          mountPaths: (Array.isArray(c.volumeMounts) ? c.volumeMounts : [])
            .map((m: AnyMap) => m?.mountPath)
            .filter((path: unknown): path is string => typeof path === 'string'),
        });
      }
    }
  }
  return found;
}

const TRUE_VALUES = new Set(['true', '1', 't']);
const FALSE_VALUES = new Set(['false', '0', 'f']);

/** Go's ParseBool, which Traefik uses for flags and annotation values alike. */
export function boolOf(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const v = value.toLowerCase();
  if (TRUE_VALUES.has(v)) return true;
  if (FALSE_VALUES.has(v)) return false;
  return null;
}

/**
 * The provider's own switch: a bare flag or `=true` turns it on, `=false` off, no flag at all
 * leaves it off. Options set without the switch are not read as "on" — that would be a guess.
 */
function providerState(flags: Map<string, string>, provider: string): ProviderState {
  const value = flags.get(`providers.${provider}`);
  if (value !== undefined) {
    const b = boolOf(value);
    return b === null ? 'unknown' : b ? 'on' : 'off';
  }
  const prefix = `providers.${provider}.`;
  return [...flags.keys()].some(k => k.startsWith(prefix)) ? 'unknown' : 'off';
}

/**
 * Providers and options from a Traefik container's arguments. Flag names are compared in
 * lower case: the Helm chart itself emits both `--providers.kubernetesingressnginx` and
 * `--providers.kubernetesingressnginx.controllerClass=...`.
 *
 * Returns a reason instead when the arguments do not tell the whole story: static config from
 * a file, no flags at all, or arguments that are not plain `--name[=value]` flags.
 */
export function parseTraefikArgs(args: string[]):
  | { reason: string }
  | {
      providers: TraefikProviders;
      nginx: NginxProviderOptions;
      scoped: { kubernetesIngress: boolean; kubernetesIngressNGINX: boolean };
      accessLogs: ProviderState;
    } {
  if (args.length === 0) {
    return {
      reason:
        'Traefik runs without arguments, so its configuration comes from a file or the environment, which this page cannot read.',
    };
  }
  const flags = new Map<string, string>();
  for (const arg of args) {
    const m = arg.match(/^--([^=]+)(?:=([\s\S]*))?$/);
    if (!m) return { reason: `Unrecognised Traefik argument "${arg}".` };
    flags.set(m[1].toLowerCase(), m[2] ?? 'true');
  }
  if (flags.has('configfile')) {
    return {
      reason:
        'Traefik reads its static configuration from a file (--configFile), which this page cannot read.',
    };
  }

  const nginxBool = (key: string, fallback: boolean): boolean | null => {
    const raw = flags.get(`providers.kubernetesingressnginx.${key}`);
    return raw === undefined ? fallback : boolOf(raw);
  };
  const ingressClassByName = nginxBool(
    'ingressclassbyname',
    NGINX_PROVIDER_DEFAULTS.ingressClassByName
  );
  const watchIngressWithoutClass = nginxBool(
    'watchingresswithoutclass',
    NGINX_PROVIDER_DEFAULTS.watchIngressWithoutClass
  );
  if (ingressClassByName === null || watchIngressWithoutClass === null) {
    return {
      reason: 'The ingress-nginx compatibility provider has an option with an unreadable value.',
    };
  }

  const accessLog = flags.get('accesslog');
  const anySet = (provider: string, options: string[]) =>
    options.some(o => flags.has(`providers.${provider}.${o}`));
  return {
    providers: {
      kubernetesCRD: providerState(flags, 'kubernetescrd'),
      kubernetesIngress: providerState(flags, 'kubernetesingress'),
      kubernetesIngressNGINX: providerState(flags, 'kubernetesingressnginx'),
    },
    nginx: {
      controllerClass:
        flags.get('providers.kubernetesingressnginx.controllerclass') ??
        NGINX_PROVIDER_DEFAULTS.controllerClass,
      ingressClass:
        flags.get('providers.kubernetesingressnginx.ingressclass') ??
        NGINX_PROVIDER_DEFAULTS.ingressClass,
      ingressClassByName,
      watchIngressWithoutClass,
    },
    scoped: {
      kubernetesIngress: anySet('kubernetesingress', [
        'ingressclass',
        'namespaces',
        'labelselector',
      ]),
      kubernetesIngressNGINX: anySet('kubernetesingressnginx', [
        'watchnamespace',
        'watchnamespaceselector',
      ]),
    },
    accessLogs:
      accessLog === undefined
        ? [...flags.keys()].some(k => k.startsWith('accesslog.'))
          ? 'unknown'
          : 'off'
        : boolOf(accessLog) === null
        ? 'unknown'
        : boolOf(accessLog)
        ? 'on'
        : 'off',
  };
}

/** One Traefik instance, read from its arguments; several or none is "unknown". */
export function runtimeFromWorkloads(workloads: TraefikWorkload[]): TraefikRuntime {
  if (workloads.length === 0) {
    return {
      status: 'unknown',
      reason: 'No Traefik Deployment, DaemonSet or StatefulSet was found in the cluster.',
    };
  }
  if (workloads.length > 1) {
    const list = workloads.map(w => `${w.kind} ${w.namespace}/${w.name}`).join(', ');
    return {
      status: 'unknown',
      reason: `Several Traefik instances run here (${list}); which one serves a given Ingress cannot be told from here.`,
    };
  }
  const w = workloads[0];
  // Traefik's file loader also finds /etc/traefik/traefik.{toml,yaml,yml} without --configFile,
  // and a file it finds wins over the arguments.
  const configMount = w.mountPaths.find(
    path => /^\/etc\/traefik\/?$/.test(path) || /(^|\/)traefik\.(toml|ya?ml)$/.test(path)
  );
  if (configMount) {
    return {
      status: 'unknown',
      reason: `Traefik mounts ${configMount}, where a configuration file would override its arguments.`,
    };
  }
  const parsed = parseTraefikArgs(w.args);
  if ('reason' in parsed) return { status: 'unknown', reason: parsed.reason };
  return {
    status: 'known',
    source: `${w.kind} ${w.namespace}/${w.name}`,
    image: w.image,
    version: traefikVersionOf(w.image),
    ...parsed,
  };
}

export type IngressHandling =
  /** Traefik's own Ingress provider: reads `traefik.ingress.kubernetes.io/*` annotations. */
  | { kind: 'native' }
  /** The ingress-nginx compatibility provider: reads `nginx.ingress.kubernetes.io/*` only. */
  | { kind: 'nginx-compat' }
  | { kind: 'not-traefik'; controller: string | null }
  | { kind: 'unknown'; reason: string };

/** Which Traefik provider, if any, turns this Ingress into routes. */
export function ingressHandling(
  ingress: IngressObject,
  classes: IngressClassInfo[],
  runtime: TraefikRuntime
): IngressHandling {
  if (runtime.status === 'unknown') return { kind: 'unknown', reason: runtime.reason };
  const { providers, nginx } = runtime;

  const byField = ingress.spec?.ingressClassName ?? null;
  const byAnnotation = ingress.metadata.annotations?.[LEGACY_CLASS_ANNOTATION] ?? null;
  const className = byField ?? byAnnotation;
  const controller = className ? classes.find(c => c.name === className)?.controller ?? null : null;

  if (!byField && byAnnotation) {
    return {
      kind: 'unknown',
      reason: `The class is set only by the deprecated ${LEGACY_CLASS_ANNOTATION} annotation, and how Traefik's providers treat it is not documented.`,
    };
  }
  if (className && !controller) {
    return {
      kind: 'unknown',
      reason: `IngressClass "${className}" was not found or could not be read, so its controller is unknown.`,
    };
  }

  // The compatibility provider takes classes whose controller matches controllerClass, or —
  // with ingressClassByName — the class named ingressClass, and class-less Ingresses only
  // with watchIngressWithoutClass.
  const compatClasses = classes.filter(
    c =>
      c.controller === nginx.controllerClass ||
      (nginx.ingressClassByName && c.name === nginx.ingressClass)
  );
  const nginxWants = className
    ? compatClasses.some(c => c.name === className)
    : nginx.watchIngressWithoutClass;
  // The native provider's handling of class-less Ingresses depends on options not read here.
  const nativeWants: boolean | null = className ? controller === TRAEFIK_INGRESS_CONTROLLER : null;

  const nginxOn = providers.kubernetesIngressNGINX === 'on';
  // With no class of its own in the cluster, the provider's class filter has nothing to match
  // and watchIngressWithoutClass lets it take classed Ingresses too (Traefik 3.7 source).
  if (nginxOn && className && compatClasses.length === 0 && nginx.watchIngressWithoutClass) {
    return {
      kind: 'unknown',
      reason:
        "No IngressClass matches the compatibility provider's controller, and with watchIngressWithoutClass it may then take classed Ingresses as well.",
    };
  }
  const nginxClaims = nginxOn && nginxWants;
  const nativeClaims = providers.kubernetesIngress === 'on' && nativeWants === true;
  if (
    (nginxClaims && runtime.scoped.kubernetesIngressNGINX) ||
    (nativeClaims && runtime.scoped.kubernetesIngress)
  ) {
    return {
      kind: 'unknown',
      reason:
        'The provider that would serve this Ingress is limited by namespace, label or class options, which this page does not evaluate.',
    };
  }
  // The native provider takes class-less Ingresses by default, so with it possibly on, a
  // class-less Ingress may get a second router without the nginx protection.
  if (nginxClaims && !className && providers.kubernetesIngress !== 'off') {
    return {
      kind: 'unknown',
      reason:
        "The Ingress has no class, and Traefik's native Ingress provider may serve it too, without the nginx annotations.",
    };
  }
  if (nginxClaims && nativeClaims) {
    return {
      kind: 'unknown',
      reason:
        'Both the native Ingress provider and the ingress-nginx compatibility provider would serve this Ingress.',
    };
  }
  if (nginxClaims) return { kind: 'nginx-compat' };
  if (nativeClaims) return { kind: 'native' };

  if (providers.kubernetesIngressNGINX === 'unknown' && nginxWants) {
    return {
      kind: 'unknown',
      reason: 'Whether the ingress-nginx compatibility provider is on could not be read.',
    };
  }
  if (providers.kubernetesIngress !== 'off' && nativeWants !== false) {
    return {
      kind: 'unknown',
      reason:
        nativeWants === null
          ? "The Ingress has no class, and whether Traefik's native Ingress provider picks it up depends on options not read here."
          : "Whether Traefik's native Ingress provider is on could not be read.",
    };
  }
  return { kind: 'not-traefik', controller };
}

/** Saving is allowed, refused, or allowed only after the user confirms the doubt. */
export type Verdict =
  | { allowed: 'yes' }
  | { allowed: 'no'; reason: string }
  | { allowed: 'confirm'; reason: string };

const YES: Verdict = { allowed: 'yes' };

function crdVerdict(runtime: TraefikRuntime, what: string): Verdict {
  if (runtime.status === 'unknown') return { allowed: 'confirm', reason: runtime.reason };
  const crd = runtime.providers.kubernetesCRD;
  if (crd === 'on') return YES;
  if (crd === 'off') {
    return {
      allowed: 'no',
      reason: `Traefik's kubernetesCRD provider is off in this cluster, so it never reads ${what}.`,
    };
  }
  return {
    allowed: 'confirm',
    reason: "Whether Traefik's kubernetesCRD provider is on could not be read.",
  };
}

/**
 * What the dialog may write onto an Ingress. Middlewares need both the native provider (it
 * reads the annotation) and the CRD provider (`@kubernetescrd` names a Middleware object);
 * the access-log annotation only the native provider.
 */
export function ingressVerdicts(
  handling: IngressHandling,
  runtime: TraefikRuntime
): { middlewares: Verdict; accessLogs: Verdict } {
  switch (handling.kind) {
    case 'nginx-compat': {
      const no: Verdict = {
        allowed: 'no',
        reason:
          'Traefik serves this Ingress through its ingress-nginx compatibility provider, which ignores traefik.ingress.kubernetes.io annotations. Its protection comes from the nginx.ingress.kubernetes.io annotations shown here.',
      };
      return { middlewares: no, accessLogs: no };
    }
    case 'not-traefik': {
      const no: Verdict = {
        allowed: 'no',
        reason: `Traefik does not serve this Ingress${
          handling.controller ? ` (its class belongs to ${handling.controller})` : ''
        }, so these annotations would do nothing.`,
      };
      return { middlewares: no, accessLogs: no };
    }
    case 'unknown': {
      const doubt: Verdict = { allowed: 'confirm', reason: handling.reason };
      return { middlewares: doubt, accessLogs: doubt };
    }
    case 'native':
      return { middlewares: crdVerdict(runtime, 'Middleware objects'), accessLogs: YES };
  }
}

/** IngressRoutes are themselves CRD objects: without the CRD provider nothing on them counts. */
export function ingressRouteVerdict(runtime: TraefikRuntime): Verdict {
  return crdVerdict(runtime, 'IngressRoutes or Middlewares');
}

/** Banner text for the Middlewares tab, or null when Traefik does read Middleware objects. */
export function middlewaresNotice(
  runtime: TraefikRuntime
): { severity: 'error' | 'warning'; text: string } | null {
  const v = crdVerdict(runtime, 'Middleware objects');
  if (v.allowed === 'yes') return null;
  return v.allowed === 'no'
    ? { severity: 'error', text: `${v.reason} Middlewares created here protect nothing.` }
    : {
        severity: 'warning',
        text: `Not known whether Traefik uses these Middlewares: ${v.reason}`,
      };
}

export function ingressHosts(ingress: IngressObject): string[] {
  const hosts = (ingress.spec?.rules ?? []).map(r => r.host || '*');
  return [...new Set(hosts)];
}

export type MiddlewareUser = {
  kind: 'Ingress' | 'IngressRoute' | 'Middleware';
  namespace: string;
  name: string;
};

/**
 * Everything listed that references the middleware, from any namespace: Ingress
 * annotations, IngressRoute routes and `chain` middlewares.
 */
export function middlewareUsers(
  mw: MiddlewareObject,
  ingresses: IngressObject[],
  ingressRoutes: IngressRouteObject[],
  middlewares: MiddlewareObject[] = []
): MiddlewareUser[] {
  const { name, namespace } = mw.metadata;
  const ref = middlewareRef(namespace, name);
  const users: MiddlewareUser[] = [];
  for (const ing of ingresses) {
    const refs = parseMiddlewareRefs(ing.metadata.annotations?.[ROUTER_MIDDLEWARES_ANNOTATION]);
    if (refs.includes(ref)) {
      users.push({ kind: 'Ingress', namespace: ing.metadata.namespace, name: ing.metadata.name });
    }
  }
  for (const ir of ingressRoutes) {
    const uses = (ir.spec?.routes ?? []).some(route =>
      (route.middlewares ?? []).some(
        m => m.name === name && refPointsAt(m, ir.metadata.namespace, namespace)
      )
    );
    if (uses) {
      users.push({
        kind: 'IngressRoute',
        namespace: ir.metadata.namespace,
        name: ir.metadata.name,
      });
    }
  }
  for (const other of middlewares) {
    const chained: MiddlewareRef[] = other.spec?.chain?.middlewares ?? [];
    const uses = chained.some(
      m => m.name === name && refPointsAt(m, other.metadata.namespace, namespace)
    );
    if (uses) {
      users.push({
        kind: 'Middleware',
        namespace: other.metadata.namespace,
        name: other.metadata.name,
      });
    }
  }
  return users;
}

/** Display names for an Ingress annotation: own-namespace middlewares by name, the rest raw. */
export function describeIngressRefs(ingress: IngressObject, knownNames: string[]): string[] {
  const ns = ingress.metadata.namespace;
  const byRef = new Map(knownNames.map(n => [middlewareRef(ns, n), n]));
  return parseMiddlewareRefs(ingress.metadata.annotations?.[ROUTER_MIDDLEWARES_ANNOTATION]).map(
    r => byRef.get(r) ?? r
  );
}

export function describeRouteRefs(route: IngressRouteRoute, namespace: string): string[] {
  return (route.middlewares ?? []).map(m =>
    m.namespace && m.namespace !== namespace ? `${m.namespace}/${m.name}` : m.name
  );
}

// ---------------------------------------------------------------------------
// Cluster I/O
// ---------------------------------------------------------------------------

export type TraefikDetection = {
  available: boolean;
  /** The removed v2 group is served, i.e. an old Traefik is installed. */
  v2Detected: boolean;
  error: string | null;
};

export async function detectTraefik(): Promise<TraefikDetection> {
  try {
    const res: any = await request(TRAEFIK_API);
    const names: string[] = (res?.resources ?? []).map((r: any) => r?.name);
    if (names.includes('middlewares')) return { available: true, v2Detected: false, error: null };
    return {
      available: false,
      v2Detected: false,
      error: `${TRAEFIK_GROUP_VERSION} is served but has no middlewares resource.`,
    };
  } catch (err) {
    let v2Detected = false;
    try {
      await request(TRAEFIK_V2_API);
      v2Detected = true;
    } catch {
      // not installed either
    }
    return { available: false, v2Detected, error: isNotFound(err) ? null : errMsg(err) };
  }
}

/**
 * The running Traefik's providers, read from its DaemonSet or Deployment. A list that fails
 * — typically no permission to read workloads cluster-wide — makes the answer unknown: a
 * Traefik may be hiding in what could not be read.
 */
export async function detectTraefikRuntime(): Promise<TraefikRuntime> {
  const kinds = [
    { kind: 'DaemonSet' as const, url: '/apis/apps/v1/daemonsets' },
    { kind: 'Deployment' as const, url: '/apis/apps/v1/deployments' },
    { kind: 'StatefulSet' as const, url: '/apis/apps/v1/statefulsets' },
  ];
  const lists = await Promise.all(
    kinds.map(async ({ kind, url }) => {
      try {
        const res: any = await request(url);
        return { kind, items: (res?.items ?? []) as AnyMap[], error: null };
      } catch (err) {
        return { kind, items: [] as AnyMap[], error: `${kind}s: ${errMsg(err)}` };
      }
    })
  );
  const failed = lists.filter(l => l.error).map(l => l.error);
  if (failed.length > 0) {
    return {
      status: 'unknown',
      reason: `Traefik's workload could not be read (${failed.join('; ')}).`,
    };
  }
  return runtimeFromWorkloads(findTraefikWorkloads(lists));
}

type Listed<T> = { items: T[]; errors: string[] };

/** One request per namespace, or one cluster-wide when none is selected. */
async function listIn<T>(
  pathFor: (namespace?: string) => string,
  namespaces: string[],
  what: string
): Promise<Listed<T>> {
  const targets: (string | undefined)[] = namespaces.length > 0 ? namespaces : [undefined];
  const errors: string[] = [];
  const lists = await Promise.all(
    targets.map(async ns => {
      try {
        const res: any = await request(pathFor(ns));
        return (res?.items ?? []) as T[];
      } catch (err) {
        errors.push(`Could not list ${what}${ns ? ` in ${ns}` : ''}: ${errMsg(err)}`);
        return [] as T[];
      }
    })
  );
  return { items: lists.flat(), errors };
}

const byNamespaceAndName = (a: { metadata: ObjectMeta }, b: { metadata: ObjectMeta }): number =>
  `${a.metadata.namespace}/${a.metadata.name}`.localeCompare(
    `${b.metadata.namespace}/${b.metadata.name}`
  );

export type TraefikData = {
  middlewares: MiddlewareObject[];
  ingresses: IngressObject[];
  ingressRoutes: IngressRouteObject[];
  ingressClasses: IngressClassInfo[];
  errors: string[];
};

/**
 * `crds: false` skips the Middleware and IngressRoute lists, for a cluster that does not serve
 * traefik.io at all — their 404s would only show up as errors.
 */
export async function loadTraefikData(
  namespaces: string[],
  { crds = true }: { crds?: boolean } = {}
): Promise<TraefikData> {
  const scoped = (plural: string, base: string) => (ns?: string) =>
    ns ? `${base}/namespaces/${ns}/${plural}` : `${base}/${plural}`;
  const none = <T>(): Promise<Listed<T>> => Promise.resolve({ items: [], errors: [] });
  const [middlewares, ingresses, ingressRoutes, classes] = await Promise.all([
    crds
      ? listIn<MiddlewareObject>(scoped('middlewares', TRAEFIK_API), namespaces, 'Middlewares')
      : none<MiddlewareObject>(),
    listIn<IngressObject>(scoped('ingresses', NETWORKING_API), namespaces, 'Ingresses'),
    crds
      ? listIn<IngressRouteObject>(
          scoped('ingressroutes', TRAEFIK_API),
          namespaces,
          'IngressRoutes'
        )
      : none<IngressRouteObject>(),
    listIn<AnyMap>(() => `${NETWORKING_API}/ingressclasses`, [], 'IngressClasses'),
  ]);
  return {
    middlewares: middlewares.items.sort(byNamespaceAndName),
    ingresses: ingresses.items.sort(byNamespaceAndName),
    ingressRoutes: ingressRoutes.items.sort(byNamespaceAndName),
    ingressClasses: classes.items.map(c => ({
      name: c?.metadata?.name ?? '',
      controller: c?.spec?.controller ?? '',
      isDefault: c?.metadata?.annotations?.[DEFAULT_CLASS_ANNOTATION] === 'true',
    })),
    errors: [
      ...middlewares.errors,
      ...ingresses.errors,
      ...ingressRoutes.errors,
      ...classes.errors,
    ],
  };
}

/** null only for a 404; any other failure must not pass for "does not exist". */
async function getOrNull(url: string): Promise<AnyMap | null> {
  try {
    return (await request(url)) as AnyMap;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

function secretUrl(namespace: string, name: string): string {
  return `/api/v1/namespaces/${namespace}/secrets/${name}`;
}

export type BasicAuthSecretInfo = {
  exists: boolean;
  managed: boolean;
  type: string | null;
  username: string | null;
};

export async function lookupBasicAuthSecret(
  namespace: string,
  secretName: string,
  middlewareName: string
): Promise<BasicAuthSecretInfo> {
  const secret = await getOrNull(secretUrl(namespace, secretName));
  if (!secret) return { exists: false, managed: false, type: null, username: null };
  const raw = secret.data?.username;
  return {
    exists: true,
    managed: isOwnBasicAuthSecret(secret, middlewareName),
    type: secret.type ?? null,
    username: typeof raw === 'string' ? tryDecodeBase64ToUtf8(raw) : null,
  };
}

export type MiddlewareSaveResult = {
  /** Fields the API server dropped because the installed CRD does not know them. */
  pruned: string[];
};

/**
 * Create or update a middleware, writing its basic-auth Secret first so the middleware
 * never points at credentials that are not there yet.
 *
 * Creating is a plain POST for both objects, so an existing Middleware or Secret makes it
 * fail instead of being taken over. Editing PUTs with the resourceVersion the list was read
 * at, so a change made since then comes back as a conflict rather than being overwritten.
 */
export async function saveMiddleware(
  form: MiddlewareForm,
  live: MiddlewareObject | null
): Promise<MiddlewareSaveResult> {
  const ns = form.namespace;
  const desired = buildMiddleware(form, live);
  const sentTypeSpec = desired.spec[form.type];

  if (!live) {
    let createdSecret: string | null = null;
    if (form.type === 'basicAuth') {
      const secretName = basicAuthSecretName(form.name);
      await createResource(
        buildBasicAuthSecret(
          form.name,
          ns,
          secretName,
          form.basicAuth.username,
          form.basicAuth.password
        )
      );
      createdSecret = secretName;
    }
    let stored: unknown;
    try {
      stored = await createResource(desired);
    } catch (err) {
      // The Secret was created a moment ago for this middleware alone; don't leave it behind.
      if (createdSecret) await deleteResource('v1', 'Secret', createdSecret, ns).catch(() => {});
      throw err;
    }
    return { pruned: prunedTypeFields(form.type, sentTypeSpec, stored) };
  }

  if (shouldWriteBasicAuthSecret(form, false)) {
    const secretName = form.basicAuth.secretName;
    const existing = await getOrNull(secretUrl(ns, secretName));
    if (existing && !isOwnBasicAuthSecret(existing, form.name)) {
      throw new Error(
        `Secret ${ns}/${secretName} already exists and was not created for this middleware.`
      );
    }
    await applyResources([
      buildBasicAuthSecret(
        form.name,
        ns,
        secretName,
        form.basicAuth.username,
        form.basicAuth.password
      ),
    ]);
  }
  let stored: unknown;
  try {
    stored = await updateResource(live, desired);
  } catch (err) {
    throw friendlyWriteError(err, `Middleware ${ns}/${form.name}`);
  }
  return { pruned: prunedTypeFields(form.type, sentTypeSpec, stored) };
}

/** Another middleware in the same namespace that reads the same Secret, if any. */
export function secretSharedWith(
  mw: MiddlewareObject,
  secretName: string,
  others: MiddlewareObject[]
): MiddlewareObject | undefined {
  return others.find(
    o =>
      o.metadata.namespace === mw.metadata.namespace &&
      o.metadata.name !== mw.metadata.name &&
      o.spec?.basicAuth?.secret === secretName
  );
}

/**
 * Deletes the middleware and the basic-auth Secret this page created for it, nothing else.
 * The Secret stays when another listed middleware still reads it.
 */
export async function deleteMiddleware(
  mw: MiddlewareObject,
  others: MiddlewareObject[] = []
): Promise<void> {
  const { name, namespace } = mw.metadata;
  await deleteResource(TRAEFIK_GROUP_VERSION, 'Middleware', name, namespace);
  const secretName = mw.spec?.basicAuth?.secret;
  if (typeof secretName !== 'string' || !secretName) return;
  if (secretSharedWith(mw, secretName, others)) return;
  let secret: AnyMap | null;
  try {
    secret = await getOrNull(secretUrl(namespace, secretName));
  } catch (err) {
    throw new Error(
      `Middleware deleted, but its Secret ${secretName} could not be checked: ${errMsg(err)}`
    );
  }
  if (isOwnBasicAuthSecret(secret, name)) {
    await deleteResource('v1', 'Secret', secretName, namespace);
  }
}

export function friendlyWriteError(err: unknown, what: string): Error {
  if (isConflict(err)) {
    return new Error(`${what} was changed by someone else meanwhile. Reload and try again.`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

export async function saveIngress(ingress: IngressObject, body: AnyMap): Promise<void> {
  const { name, namespace } = ingress.metadata;
  try {
    await patchResource('networking.k8s.io/v1', 'Ingress', name, body, namespace);
  } catch (err) {
    throw friendlyWriteError(err, `Ingress ${namespace}/${name}`);
  }
}

/**
 * Replaces `spec.routes` with a merge patch guarded by resourceVersion, then reads the
 * object back to see whether the access-log setting survived the CRD schema.
 */
export async function saveIngressRoute(
  ir: IngressRouteObject,
  routes: IngressRouteRoute[]
): Promise<{ observabilityPruned: boolean }> {
  const { name, namespace } = ir.metadata;
  try {
    await patchResource(
      TRAEFIK_GROUP_VERSION,
      'IngressRoute',
      name,
      { metadata: { resourceVersion: ir.metadata.resourceVersion }, spec: { routes } },
      namespace
    );
  } catch (err) {
    throw friendlyWriteError(err, `IngressRoute ${namespace}/${name}`);
  }
  let fresh: any;
  try {
    fresh = await request(`${TRAEFIK_API}/namespaces/${namespace}/ingressroutes/${name}`);
  } catch {
    // The write went through; failing to read it back must not report the save as failed.
    return { observabilityPruned: false };
  }
  return { observabilityPruned: observabilityDropped(routes, fresh?.spec?.routes ?? []) };
}
