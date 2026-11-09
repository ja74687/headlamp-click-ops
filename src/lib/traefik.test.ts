import { describe, expect, it } from 'vitest';
import { nginxProtection } from './nginxAnnotations';
import {
  attachedIngressMiddlewares,
  attachedRouteMiddlewares,
  buildBasicAuthSecret,
  buildIngressPatch,
  buildMiddleware,
  buildTypeSpec,
  CLICK_OPS_MANAGED_BY,
  detectType,
  editRoute,
  emptyForm,
  findTraefikWorkloads,
  formFromMiddleware,
  IngressClassInfo,
  ingressHandling,
  IngressObject,
  ingressRouteVerdict,
  ingressVerdicts,
  isFormEditable,
  isOwnBasicAuthSecret,
  isTraefikImage,
  isValidHeaderValue,
  isValidResourceName,
  isValidSourceRange,
  MiddlewareForm,
  MiddlewareObject,
  middlewaresNotice,
  middlewareUsers,
  observabilityDropped,
  parseAccessLogsAnnotation,
  parseTraefikArgs,
  prunedTypeFields,
  resolveIngressClass,
  routeAccessLogs,
  ROUTER_ACCESSLOGS_ANNOTATION,
  ROUTER_MIDDLEWARES_ANNOTATION,
  runtimeFromWorkloads,
  secretSharedWith,
  setIngressMiddlewares,
  shouldWriteBasicAuthSecret,
  summarizeMiddleware,
  TRAEFIK_INGRESS_CONTROLLER,
  TraefikRuntime,
  traefikVersionOf,
  TraefikWorkload,
  validateMiddlewareForm,
} from './traefik';

function mw(name: string, spec: Record<string, any>, namespace = 'web'): MiddlewareObject {
  return { metadata: { name, namespace }, spec };
}

function formFor(
  type: MiddlewareForm['type'],
  patch: Partial<MiddlewareForm> = {}
): MiddlewareForm {
  return { ...emptyForm('web'), name: 'mw', type, ...patch };
}

describe('isValidSourceRange', () => {
  it.each([
    '10.0.0.1',
    '10.0.0.0/8',
    '0.0.0.0/0',
    '192.168.1.7/32',
    '::1',
    '::',
    '::1/128',
    '2001:db8::/32',
    'fe80::1:2',
    '1:2:3:4:5:6:7:8',
    '1:2:3:4:5:6:7::',
    '::ffff:10.0.0.1',
    '1:2:3:4:5:6:10.0.0.1',
    ' 10.0.0.1 ',
  ])('accepts %s', value => {
    expect(isValidSourceRange(value)).toBe(true);
  });

  it.each([
    '',
    '010.0.0.1',
    '10.00.0.1',
    '10.0.0.0/08',
    '::ffff:010.0.0.1',
    '10.0.0',
    '10.0.0.256',
    '10.0.0.0/33',
    '10.0.0.0/',
    '10.0.0.0/abc',
    'example.com',
    '1:2:3:4:5:6:7:8:9',
    '1::2:3:4:5:6:7:8',
    '1:::2',
    ':1:2:3:4:5:6:7',
    '2001:db8::/129',
    'gggg::1',
  ])('rejects %s', value => {
    expect(isValidSourceRange(value)).toBe(false);
  });
});

describe('isValidResourceName', () => {
  it('follows DNS-1123 label rules', () => {
    expect(isValidResourceName('ip-allow')).toBe(true);
    expect(isValidResourceName('a')).toBe(true);
    expect(isValidResourceName('ends-')).toBe(false);
    expect(isValidResourceName('-starts')).toBe(false);
    expect(isValidResourceName('has.dot')).toBe(false);
    expect(isValidResourceName('Upper')).toBe(false);
    expect(isValidResourceName('a'.repeat(64))).toBe(false);
  });
});

describe('detectType and isFormEditable', () => {
  it('recognises a single supported key', () => {
    expect(detectType({ ipAllowList: { sourceRange: ['10.0.0.0/8'] } })).toBe('ipAllowList');
    expect(detectType({ basicAuth: { secret: 's' } })).toBe('basicAuth');
  });

  it('calls anything else "other"', () => {
    expect(detectType({ chain: { middlewares: [] } })).toBe('other');
    expect(detectType({ headers: {}, compress: {} })).toBe('other');
    expect(detectType({})).toBe('other');
    expect(detectType(undefined)).toBe('other');
  });

  it('refuses to edit a redirect that does not go to https', () => {
    expect(isFormEditable(mw('r', { redirectScheme: { scheme: 'https' } }))).toBe(true);
    expect(isFormEditable(mw('r', { redirectScheme: { scheme: 'http' } }))).toBe(false);
    expect(isFormEditable(mw('c', { chain: {} }))).toBe(false);
  });
});

describe('summarizeMiddleware', () => {
  it('describes each type in a few words', () => {
    expect(
      summarizeMiddleware(
        mw('a', { ipAllowList: { sourceRange: ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4'] } })
      )
    ).toBe('allow 1.1.1.1, 2.2.2.2, 3.3.3.3 +1 more');
    expect(summarizeMiddleware(mw('b', { basicAuth: { secret: 'creds' } }))).toContain('creds');
    expect(summarizeMiddleware(mw('c', { rateLimit: { average: 10, period: '1m' } }))).toBe(
      '10 requests per 1m'
    );
    expect(summarizeMiddleware(mw('d', { chain: {}, compress: {} }))).toBe('chain + compress');
  });
});

describe('buildTypeSpec keeps what the form does not render', () => {
  it('keeps contentSecurityPolicy on a headers middleware', () => {
    const live = { contentSecurityPolicy: "default-src 'self'", frameDeny: true };
    const form = formFromMiddleware(mw('h', { headers: live }));
    form.headers.frameDeny = false;
    form.headers.contentTypeNosniff = true;
    const spec = buildTypeSpec(form, live);
    expect(spec.contentSecurityPolicy).toBe("default-src 'self'");
    expect(spec.frameDeny).toBeUndefined();
    expect(spec.contentTypeNosniff).toBe(true);
  });

  it('keeps ipStrategy.excludedIPs when the proxy depth is switched off', () => {
    const live = {
      sourceRange: ['10.0.0.0/8'],
      ipStrategy: { depth: 2, excludedIPs: ['10.1.1.1'] },
    };
    const form = formFromMiddleware(mw('ip', { ipAllowList: live }));
    expect(form.ipAllowList.behindProxy).toBe(true);
    expect(form.ipAllowList.depth).toBe(2);
    form.ipAllowList.behindProxy = false;
    const spec = buildTypeSpec(form, live);
    expect(spec.ipStrategy).toEqual({ excludedIPs: ['10.1.1.1'] });
  });

  it('drops ipStrategy entirely when nothing is left in it', () => {
    const live = { sourceRange: ['10.0.0.0/8'], ipStrategy: { depth: 1 } };
    const form = formFromMiddleware(mw('ip', { ipAllowList: live }));
    form.ipAllowList.behindProxy = false;
    expect(buildTypeSpec(form, live).ipStrategy).toBeUndefined();
  });

  it('keeps a rateLimit sourceCriterion and a numeric period that was not changed', () => {
    const live = { average: 5, period: 60, sourceCriterion: { requestHost: true } };
    const form = formFromMiddleware(mw('rl', { rateLimit: live }));
    form.rateLimit.average = '7';
    const spec = buildTypeSpec(form, live);
    expect(spec).toEqual({ average: 7, period: 60, sourceCriterion: { requestHost: true } });
  });

  it('does not mutate the live object', () => {
    const live = { sourceRange: ['10.0.0.0/8'], rejectStatusCode: 404 };
    const form = formFromMiddleware(mw('ip', { ipAllowList: live }));
    form.ipAllowList.rejectStatusCode = '';
    buildTypeSpec(form, live);
    expect(live.rejectStatusCode).toBe(404);
  });
});

describe('buildTypeSpec per type', () => {
  it('builds an IP allowlist with depth and a custom reject code', () => {
    const form = formFor('ipAllowList');
    form.ipAllowList = {
      sourceRange: [' 10.0.0.0/8 ', ''],
      behindProxy: true,
      depth: 1,
      rejectStatusCode: '404',
    };
    expect(buildTypeSpec(form)).toEqual({
      sourceRange: ['10.0.0.0/8'],
      ipStrategy: { depth: 1 },
      rejectStatusCode: 404,
    });
  });

  it('points basic auth at the generated Secret on create', () => {
    const form = formFor('basicAuth', { name: 'login' });
    expect(buildTypeSpec(form)).toEqual({ secret: 'login-basic-auth', removeHeader: true });
  });

  it('keeps the existing Secret name on edit', () => {
    const live = { secret: 'handmade', realm: 'Staff' };
    const form = formFromMiddleware(mw('login', { basicAuth: live }));
    expect(buildTypeSpec(form, live)).toEqual({ secret: 'handmade', realm: 'Staff' });
  });

  it('redirects to https only, with optional permanence and port', () => {
    const form = formFor('redirectScheme');
    form.redirectScheme = { permanent: false, port: '8443' };
    expect(buildTypeSpec(form)).toEqual({ scheme: 'https', port: '8443' });
  });

  it('builds security headers and custom headers', () => {
    const form = formFor('headers');
    form.headers.customResponseHeaders = [{ key: 'X-Robots-Tag', value: 'noindex' }];
    expect(buildTypeSpec(form)).toEqual({
      stsSeconds: 31536000,
      stsIncludeSubdomains: true,
      frameDeny: true,
      contentTypeNosniff: true,
      referrerPolicy: 'strict-origin-when-cross-origin',
      customResponseHeaders: { 'X-Robots-Tag': 'noindex' },
    });
  });

  it('builds a rate limit and a strip prefix', () => {
    expect(buildTypeSpec(formFor('rateLimit'))).toEqual({ average: 100, period: '1s', burst: 100 });
    const strip = formFor('stripPrefix');
    strip.stripPrefix.prefixes = ['/api', ' '];
    expect(buildTypeSpec(strip)).toEqual({ prefixes: ['/api'] });
  });
});

describe('buildMiddleware', () => {
  it('labels a new middleware as click-ops managed', () => {
    const built = buildMiddleware(formFor('stripPrefix'));
    expect(built.apiVersion).toBe('traefik.io/v1alpha1');
    expect(built.metadata.labels).toEqual({
      'app.kubernetes.io/managed-by': CLICK_OPS_MANAGED_BY,
    });
  });

  it('does not stamp the label onto an existing one, which may belong to Helm', () => {
    const live = mw('strip', { stripPrefix: { prefixes: ['/a'] } });
    const built = buildMiddleware(formFromMiddleware(live), live);
    expect((built.metadata as any).labels).toBeUndefined();
  });
});

describe('basic auth Secret', () => {
  it('is a kubernetes.io/basic-auth Secret with base64 username and password', () => {
    const secret = buildBasicAuthSecret('login', 'web', 'login-basic-auth', 'anna', 'zażółć');
    expect(secret.type).toBe('kubernetes.io/basic-auth');
    expect(atob(secret.data.username)).toBe('anna');
    expect(
      new TextDecoder().decode(Uint8Array.from(atob(secret.data.password), c => c.charCodeAt(0)))
    ).toBe('zażółć');
    expect(isOwnBasicAuthSecret(secret, 'login')).toBe(true);
    expect(isOwnBasicAuthSecret(secret, 'other')).toBe(false);
    expect(isOwnBasicAuthSecret(null, 'login')).toBe(false);
  });

  it('is written on create, and on edit only with a new password for our own Secret', () => {
    const form = formFor('basicAuth');
    expect(shouldWriteBasicAuthSecret(form, true)).toBe(true);
    expect(shouldWriteBasicAuthSecret(form, false)).toBe(false);
    form.basicAuth.credentialsManaged = true;
    expect(shouldWriteBasicAuthSecret(form, false)).toBe(false);
    form.basicAuth.password = 'new';
    expect(shouldWriteBasicAuthSecret(form, false)).toBe(true);
    form.basicAuth.credentialsManaged = false;
    expect(shouldWriteBasicAuthSecret(form, false)).toBe(false);
  });
});

describe('validateMiddlewareForm', () => {
  it('requires a valid name', () => {
    expect(validateMiddlewareForm(formFor('stripPrefix', { name: '' }), true)).toContain(
      'Name is required.'
    );
    expect(
      validateMiddlewareForm(formFor('stripPrefix', { name: 'Bad_Name' }), true).length
    ).toBeGreaterThan(0);
  });

  it('checks every source range', () => {
    const form = formFor('ipAllowList');
    form.ipAllowList.sourceRange = ['10.0.0.0/8', 'nope'];
    expect(validateMiddlewareForm(form, true)).toEqual([
      '"nope" is not an IP address or CIDR network.',
    ]);
  });

  it('needs credentials on create but lets an edit keep them', () => {
    const create = formFor('basicAuth');
    expect(validateMiddlewareForm(create, true)).toEqual([
      'Username is required.',
      'Password is required.',
    ]);
    const edit = formFor('basicAuth');
    edit.basicAuth = {
      ...edit.basicAuth,
      credentialsManaged: true,
      existingUsername: 'anna',
      username: 'anna',
    };
    expect(validateMiddlewareForm(edit, false)).toEqual([]);
    edit.basicAuth.username = 'bob';
    expect(validateMiddlewareForm(edit, false)).toEqual([
      'Changing the username needs a password as well.',
    ]);
  });

  it('rejects an empty headers middleware but accepts one that only keeps live fields', () => {
    const form = formFor('headers');
    form.headers = {
      ...form.headers,
      stsSeconds: 0,
      stsIncludeSubdomains: false,
      frameDeny: false,
      contentTypeNosniff: false,
      referrerPolicy: '',
    };
    expect(validateMiddlewareForm(form, true)).toEqual(['Turn on at least one header option.']);
    expect(validateMiddlewareForm(form, false, { contentSecurityPolicy: 'x' })).toEqual([]);
  });

  it('does not let HSTS sub-options alone count as a header option', () => {
    const form = formFor('headers');
    form.headers = {
      ...form.headers,
      stsSeconds: 0,
      stsIncludeSubdomains: true,
      stsPreload: true,
      frameDeny: false,
      contentTypeNosniff: false,
      referrerPolicy: '',
    };
    expect(buildTypeSpec(form)).toEqual({});
    expect(validateMiddlewareForm(form, true)).toEqual(['Turn on at least one header option.']);
  });

  it('drops includeSubdomains and preload from the live object once HSTS is off', () => {
    const live = { stsSeconds: 300, stsIncludeSubdomains: true, stsPreload: true, frameDeny: true };
    const form = formFromMiddleware(mw('h', { headers: live }));
    form.headers.stsSeconds = 0;
    expect(buildTypeSpec(form, live)).toEqual({ frameDeny: true });
  });

  it('rejects control characters in header values but allows a tab', () => {
    expect(isValidHeaderValue('a\tb')).toBe(true);
    expect(isValidHeaderValue('ok value')).toBe(true);
    expect(isValidHeaderValue('a\r\nX-Injected: 1')).toBe(false);
    expect(isValidHeaderValue('a\nb')).toBe(false);
    expect(isValidHeaderValue('a\u0000b')).toBe(false);
    expect(isValidHeaderValue('a\u007fb')).toBe(false);
    const form = formFor('headers');
    form.headers.customResponseHeaders = [{ key: 'X-Test', value: 'a\r\nSet-Cookie: x' }];
    expect(validateMiddlewareForm(form, true)).toEqual([
      'The value of "X-Test" contains a line break or another control character.',
    ]);
  });

  it('checks the name only when creating, since an edit cannot change it', () => {
    const form = formFor('stripPrefix', { name: 'my.mw' });
    form.stripPrefix.prefixes = ['/a'];
    expect(validateMiddlewareForm(form, true)).toHaveLength(1);
    expect(validateMiddlewareForm(form, false)).toEqual([]);
  });

  it('checks rate limit numbers and strip prefixes', () => {
    const rl = formFor('rateLimit');
    rl.rateLimit = { average: '0', period: '1s', burst: 'x' };
    expect(validateMiddlewareForm(rl, true)).toHaveLength(2);
    const sp = formFor('stripPrefix');
    sp.stripPrefix.prefixes = ['api'];
    expect(validateMiddlewareForm(sp, true)).toEqual(['Prefix "api" must start with "/".']);
  });
});

describe('Ingress middleware annotation', () => {
  const known = ['auth', 'allow', 'redirect'];

  it('keeps foreign entries in place and appends new ones', () => {
    const current = 'default-x@kubernetescrd,web-auth@kubernetescrd,compress@file';
    expect(setIngressMiddlewares(current, 'web', known, ['auth', 'allow'])).toBe(
      'default-x@kubernetescrd,web-auth@kubernetescrd,compress@file,web-allow@kubernetescrd'
    );
  });

  it('keeps the order of entries that stay selected, since that is the run order', () => {
    const current = 'web-redirect@kubernetescrd,web-auth@kubernetescrd';
    expect(setIngressMiddlewares(current, 'web', known, ['auth', 'redirect'])).toBe(current);
  });

  it('removes deselected entries and returns null when nothing is left', () => {
    expect(setIngressMiddlewares('web-auth@kubernetescrd', 'web', known, [])).toBeNull();
    expect(setIngressMiddlewares(undefined, 'web', known, [])).toBeNull();
    expect(setIngressMiddlewares('a@file, web-auth@kubernetescrd ,', 'web', known, [])).toBe(
      'a@file'
    );
  });

  it('reads which known middlewares are attached', () => {
    expect(
      attachedIngressMiddlewares('web-auth@kubernetescrd,other-allow@kubernetescrd', 'web', known)
    ).toEqual(['auth']);
  });

  it('builds a merge patch with resourceVersion and null for removals', () => {
    const ingress: IngressObject = {
      metadata: {
        name: 'site',
        namespace: 'web',
        resourceVersion: '42',
        annotations: { [ROUTER_MIDDLEWARES_ANNOTATION]: 'web-auth@kubernetescrd' },
      },
    };
    expect(buildIngressPatch(ingress, known, [], 'on')).toEqual({
      metadata: {
        resourceVersion: '42',
        annotations: {
          [ROUTER_MIDDLEWARES_ANNOTATION]: null,
          [ROUTER_ACCESSLOGS_ANNOTATION]: 'true',
        },
      },
    });
  });

  it('leaves the access log annotation alone when the switch was not moved', () => {
    const ingress: IngressObject = {
      metadata: {
        name: 'site',
        namespace: 'web',
        resourceVersion: '42',
        // Read as "default", but not absent: deleting it would change behaviour.
        annotations: { [ROUTER_ACCESSLOGS_ANNOTATION]: '1' },
      },
    };
    const patch = buildIngressPatch(ingress, known, ['auth'], 'default');
    expect(patch.metadata.annotations).toEqual({
      [ROUTER_MIDDLEWARES_ANNOTATION]: 'web-auth@kubernetescrd',
    });
    expect(buildIngressPatch(ingress, known, ['auth'], 'off').metadata.annotations).toEqual({
      [ROUTER_MIDDLEWARES_ANNOTATION]: 'web-auth@kubernetescrd',
      [ROUTER_ACCESSLOGS_ANNOTATION]: 'false',
    });
  });

  it('parses the access log annotation as a tri-state', () => {
    expect(parseAccessLogsAnnotation('true')).toBe('on');
    expect(parseAccessLogsAnnotation('False')).toBe('off');
    expect(parseAccessLogsAnnotation(undefined)).toBe('default');
    expect(parseAccessLogsAnnotation('maybe')).toBe('default');
  });
});

describe('IngressRoute route editing', () => {
  const known = ['auth', 'allow'];
  const route = {
    match: 'Host(`a.example`)',
    services: [{ name: 'app', port: 80 }],
    middlewares: [
      { name: 'shared', namespace: 'infra' },
      { name: 'auth' },
      { name: 'allow', namespace: 'web' },
      { name: 'unlisted' },
    ],
    observability: { metrics: false, accessLogs: true },
  };

  it('reads attached middlewares and the access log switch', () => {
    expect(attachedRouteMiddlewares(route, 'web', known)).toEqual(['auth', 'allow']);
    expect(routeAccessLogs(route)).toBe('on');
    expect(routeAccessLogs({})).toBe('default');
  });

  it('keeps foreign and unlisted references and other observability fields', () => {
    const next = editRoute(route, 'web', known, { selected: ['allow'], accessLogs: 'off' });
    expect(next.middlewares).toEqual([
      { name: 'shared', namespace: 'infra' },
      { name: 'allow', namespace: 'web' },
      { name: 'unlisted' },
    ]);
    expect(next.observability).toEqual({ metrics: false, accessLogs: false });
    expect(next.services).toEqual(route.services);
    expect(route.middlewares).toHaveLength(4);
  });

  it('appends newly selected middlewares without a namespace', () => {
    const next = editRoute({ match: 'm' }, 'web', known, {
      selected: ['auth'],
      accessLogs: 'default',
    });
    expect(next).toEqual({ match: 'm', middlewares: [{ name: 'auth' }] });
  });

  it('removes empty middlewares and observability blocks', () => {
    const next = editRoute(
      { match: 'm', middlewares: [{ name: 'auth' }], observability: { accessLogs: true } },
      'web',
      known,
      { selected: [], accessLogs: 'default' }
    );
    expect(next).toEqual({ match: 'm' });
  });

  it('notices when the API server pruned observability', () => {
    const sent = [{ match: 'm', observability: { accessLogs: true } }, { match: 'n' }];
    expect(observabilityDropped(sent, [{ match: 'm' }, { match: 'n' }])).toBe(true);
    expect(
      observabilityDropped(sent, [
        { match: 'm', observability: { accessLogs: true } },
        { match: 'n' },
      ])
    ).toBe(false);
  });
});

describe('resolveIngressClass', () => {
  const classes = [
    { name: 'traefik', controller: TRAEFIK_INGRESS_CONTROLLER, isDefault: true },
    { name: 'nginx', controller: 'k8s.io/ingress-nginx', isDefault: false },
  ];
  const ing = (spec: any, annotations?: Record<string, string>): IngressObject => ({
    metadata: { name: 'i', namespace: 'web', annotations },
    spec,
  });

  it('uses ingressClassName first', () => {
    expect(resolveIngressClass(ing({ ingressClassName: 'nginx' }), classes)).toEqual({
      className: 'nginx',
      controller: 'k8s.io/ingress-nginx',
      handledByTraefik: false,
    });
  });

  it('falls back to the legacy annotation, then to the default class', () => {
    expect(
      resolveIngressClass(ing({}, { 'kubernetes.io/ingress.class': 'nginx' }), classes)
        .handledByTraefik
    ).toBe(false);
    expect(resolveIngressClass(ing({}), classes).handledByTraefik).toBe(true);
  });

  it('cannot tell without a matching IngressClass', () => {
    expect(
      resolveIngressClass(ing({ ingressClassName: 'ghost' }), classes).handledByTraefik
    ).toBeNull();
    expect(resolveIngressClass(ing({}), []).handledByTraefik).toBeNull();
  });
});

describe('middlewareUsers', () => {
  it('finds Ingresses and IngressRoutes that reference the middleware', () => {
    const auth = mw('auth', { basicAuth: { secret: 's' } });
    const users = middlewareUsers(
      auth,
      [
        {
          metadata: {
            name: 'site',
            namespace: 'web',
            annotations: { [ROUTER_MIDDLEWARES_ANNOTATION]: 'web-auth@kubernetescrd' },
          },
        },
        { metadata: { name: 'other', namespace: 'web' } },
      ],
      [
        {
          metadata: { name: 'r1', namespace: 'web' },
          spec: { routes: [{ middlewares: [{ name: 'auth' }] }] },
        },
        {
          metadata: { name: 'r2', namespace: 'api' },
          spec: { routes: [{ middlewares: [{ name: 'auth' }] }] },
        },
        {
          metadata: { name: 'r3', namespace: 'api' },
          spec: { routes: [{ middlewares: [{ name: 'auth', namespace: 'web' }] }] },
        },
      ]
    );
    expect(users.map(u => `${u.kind}/${u.namespace}/${u.name}`)).toEqual([
      'Ingress/web/site',
      'IngressRoute/web/r1',
      'IngressRoute/api/r3',
    ]);
  });
});

describe('middlewareUsers with chains', () => {
  it('counts a chain that includes the middleware, from its own or an explicit namespace', () => {
    const auth = mw('auth', { basicAuth: { secret: 's' } });
    const users = middlewareUsers(
      auth,
      [],
      [],
      [
        mw('secure', { chain: { middlewares: [{ name: 'redirect' }, { name: 'auth' }] } }),
        mw('elsewhere', { chain: { middlewares: [{ name: 'auth' }] } }, 'api'),
        mw('explicit', { chain: { middlewares: [{ name: 'auth', namespace: 'web' }] } }, 'api'),
        mw('auth', { basicAuth: { secret: 's' } }),
      ]
    );
    expect(users.map(u => `${u.kind}/${u.namespace}/${u.name}`)).toEqual([
      'Middleware/web/secure',
      'Middleware/api/explicit',
    ]);
  });
});

describe('secretSharedWith', () => {
  it('finds another middleware in the same namespace reading the same Secret', () => {
    const a = mw('a', { basicAuth: { secret: 'creds' } });
    const b = mw('b', { basicAuth: { secret: 'creds' } });
    const c = mw('c', { basicAuth: { secret: 'creds' } }, 'api');
    expect(secretSharedWith(a, 'creds', [a, b, c])?.metadata.name).toBe('b');
    expect(secretSharedWith(a, 'creds', [a, c])).toBeUndefined();
  });
});

describe('prunedTypeFields', () => {
  const stored = (spec: any) => ({ metadata: { name: 'x', namespace: 'web' }, spec });

  it('reports the whole type when the CRD does not know it', () => {
    // Traefik v2.10/2.11 serve traefik.io but only know ipWhiteList.
    expect(prunedTypeFields('ipAllowList', { sourceRange: ['10.0.0.0/8'] }, stored({}))).toEqual([
      'spec.ipAllowList',
    ]);
  });

  it('reports single fields that were dropped', () => {
    expect(
      prunedTypeFields(
        'ipAllowList',
        { sourceRange: ['10.0.0.0/8'], rejectStatusCode: 404 },
        stored({ ipAllowList: { sourceRange: ['10.0.0.0/8'] } })
      )
    ).toEqual(['spec.ipAllowList.rejectStatusCode']);
  });

  it('reports nothing when everything survived or the response cannot tell', () => {
    const sent = { sourceRange: ['10.0.0.0/8'] };
    expect(prunedTypeFields('ipAllowList', sent, stored({ ipAllowList: sent }))).toEqual([]);
    expect(prunedTypeFields('ipAllowList', sent, {})).toEqual([]);
    expect(prunedTypeFields('ipAllowList', sent, undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Which provider reads what
// ---------------------------------------------------------------------------

/** The arguments of the beta cluster's Traefik DaemonSet, as `kubectl get ds` printed them. */
const COMPAT_ARGS = [
  '--global.checkNewVersion=false',
  '--entryPoints.metrics.address=:9100/tcp',
  '--entryPoints.traefik.address=:8080/tcp',
  '--entryPoints.web.address=:8000/tcp',
  '--entryPoints.websecure.address=:8443/tcp',
  '--api.dashboard=true',
  '--ping=true',
  '--metrics.prometheus=true',
  '--metrics.prometheus.entrypoint=metrics',
  '--providers.file.directory=/etc/traefik/dynamic',
  '--providers.file.watch=true',
  '--providers.kubernetesingressnginx',
  '--providers.kubernetesingressnginx.controllerClass=k8s.io/ingress-nginx',
  '--providers.kubernetesingressnginx.disableSvcExternalName=false',
  '--providers.kubernetesingressnginx.httpEntryPoint=web',
  '--providers.kubernetesingressnginx.httpsEntryPoint=websecure',
  '--providers.kubernetesingressnginx.ingressClass=nginx',
  '--providers.kubernetesingressnginx.ingressClassByName=false',
  '--providers.kubernetesingressnginx.watchIngressWithoutClass=false',
  '--entryPoints.websecure.http.middlewares=hsts@file',
  '--entryPoints.websecure.http.tls=true',
  '--log.level=INFO',
  '--accesslog=true',
  '--accesslog.format=json',
  '--accesslog.fields.defaultmode=keep',
  '--accesslog.fields.headers.defaultmode=drop',
  '--accesslog.fields.headers.names.Referer=keep',
  '--accesslog.fields.headers.names.User-Agent=keep',
];

const NATIVE_ARGS = [
  '--entryPoints.web.address=:8000/tcp',
  '--providers.kubernetescrd',
  '--providers.kubernetesingress',
];

function workload(
  args: string[],
  image = 'docker.io/traefik:v3.7.17',
  mountPaths: string[] = ['/etc/traefik/dynamic', '/data', '/tmp']
): TraefikWorkload {
  return { kind: 'DaemonSet', namespace: 'traefik', name: 'traefik', image, args, mountPaths };
}

const runtimeOf = (args: string[]) => runtimeFromWorkloads([workload(args)]);

/** public (default) and nginx both point at ingress-nginx's controller, as on the beta cluster. */
const COMPAT_CLASSES: IngressClassInfo[] = [
  { name: 'public', controller: 'k8s.io/ingress-nginx', isDefault: true },
  { name: 'nginx', controller: 'k8s.io/ingress-nginx', isDefault: false },
];
const TRAEFIK_CLASSES: IngressClassInfo[] = [
  { name: 'traefik', controller: TRAEFIK_INGRESS_CONTROLLER, isDefault: true },
];

function ing(
  className: string | undefined,
  annotations: Record<string, string> = {},
  tls = false
): IngressObject {
  return {
    metadata: { name: 'panel', namespace: 'security', annotations },
    spec: {
      ...(className ? { ingressClassName: className } : {}),
      rules: [{ host: 'security.example.com' }],
      ...(tls ? { tls: [{ hosts: ['security.example.com'], secretName: 'panel-tls' }] } : {}),
    },
  };
}

describe('isTraefikImage / findTraefikWorkloads', () => {
  it('recognises Traefik images, including the k3s mirror, and nothing else', () => {
    expect(isTraefikImage('traefik:v3.7')).toBe(true);
    expect(isTraefikImage('docker.io/traefik:v3.7.17')).toBe(true);
    expect(isTraefikImage('rancher/mirrored-library-traefik:3.3.2')).toBe(true);
    expect(isTraefikImage('docker.io/traefik@sha256:abc')).toBe(true);
    expect(isTraefikImage('registry.k8s.io/ingress-nginx/controller:v1.12.0')).toBe(false);
    expect(isTraefikImage('example.com/traefik-forward-auth:2')).toBe(false);
  });

  it('picks the Traefik container out of DaemonSets and Deployments', () => {
    const found = findTraefikWorkloads([
      {
        kind: 'DaemonSet',
        items: [
          {
            metadata: { namespace: 'traefik', name: 'traefik' },
            spec: {
              template: { spec: { containers: [{ image: 'traefik:v3.7', args: ['--a'] }] } },
            },
          },
        ],
      },
      {
        kind: 'Deployment',
        items: [
          {
            metadata: { namespace: 'web', name: 'app' },
            spec: { template: { spec: { containers: [{ image: 'nginx:1.27' }] } } },
          },
        ],
      },
    ]);
    expect(found).toEqual([
      {
        kind: 'DaemonSet',
        namespace: 'traefik',
        name: 'traefik',
        image: 'traefik:v3.7',
        args: ['--a'],
        mountPaths: [],
      },
    ]);
  });

  it('also finds StatefulSets, Traefik Hub and Enterprise, and records mounts', () => {
    const container = (image: string) => ({
      spec: {
        template: {
          spec: { containers: [{ image, volumeMounts: [{ mountPath: '/etc/traefik' }] }] },
        },
      },
    });
    const found = findTraefikWorkloads([
      {
        kind: 'StatefulSet',
        items: [
          {
            metadata: { namespace: 'a', name: 'hub' },
            ...container('ghcr.io/traefik/traefik-hub:v3.4'),
          },
          { metadata: { namespace: 'b', name: 'ee' }, ...container('traefik/traefikee:v2.11') },
        ],
      },
    ]);
    expect(found.map(w => w.name)).toEqual(['hub', 'ee']);
    expect(found[0].mountPaths).toEqual(['/etc/traefik']);
  });
});

describe('traefikVersionOf', () => {
  it('reads the proxy version from the tag', () => {
    expect(traefikVersionOf('docker.io/traefik:v3.7.17')).toEqual({
      major: 3,
      minor: 7,
      patch: 17,
    });
    expect(traefikVersionOf('rancher/mirrored-library-traefik:3.6.4')).toEqual({
      major: 3,
      minor: 6,
      patch: 4,
    });
    expect(traefikVersionOf('traefik:3.7')).toEqual({ major: 3, minor: 7, patch: 0 });
  });

  it('says nothing for latest, a digest, or Hub/Enterprise versions', () => {
    expect(traefikVersionOf('traefik:latest')).toBeNull();
    expect(traefikVersionOf('traefik@sha256:abc')).toBeNull();
    expect(traefikVersionOf('traefik/traefik-hub:v3.4.0')).toBeNull();
  });
});

describe('parseTraefikArgs', () => {
  it('reads the ingress-nginx compatibility setup: only that provider on', () => {
    expect(parseTraefikArgs(COMPAT_ARGS)).toEqual({
      providers: { kubernetesCRD: 'off', kubernetesIngress: 'off', kubernetesIngressNGINX: 'on' },
      nginx: {
        controllerClass: 'k8s.io/ingress-nginx',
        ingressClass: 'nginx',
        ingressClassByName: false,
        watchIngressWithoutClass: false,
      },
      scoped: { kubernetesIngress: false, kubernetesIngressNGINX: false },
      accessLogs: 'on',
    });
  });

  it('notes options that narrow what a provider takes', () => {
    const parsed = parseTraefikArgs([
      '--providers.kubernetesingressnginx',
      '--providers.kubernetesingressnginx.watchNamespace=web',
      '--providers.kubernetesingress',
      '--providers.kubernetesingress.ingressClass=internal',
    ]);
    expect('scoped' in parsed && parsed.scoped).toEqual({
      kubernetesIngress: true,
      kubernetesIngressNGINX: true,
    });
  });

  it('reads a native install', () => {
    const parsed = parseTraefikArgs(NATIVE_ARGS);
    expect('providers' in parsed && parsed.providers).toEqual({
      kubernetesCRD: 'on',
      kubernetesIngress: 'on',
      kubernetesIngressNGINX: 'off',
    });
  });

  it('honours an explicit =false and ignores flag case', () => {
    const parsed = parseTraefikArgs([
      '--providers.kubernetesCRD=false',
      '--Providers.KubernetesIngress=TRUE',
    ]);
    expect('providers' in parsed && parsed.providers.kubernetesCRD).toBe('off');
    expect('providers' in parsed && parsed.providers.kubernetesIngress).toBe('on');
  });

  it('does not read options without the provider switch as "on"', () => {
    const parsed = parseTraefikArgs(['--providers.kubernetescrd.allowCrossNamespace=true']);
    expect('providers' in parsed && parsed.providers.kubernetesCRD).toBe('unknown');
  });

  it('gives up when the configuration is not in the arguments', () => {
    expect(parseTraefikArgs([])).toHaveProperty('reason');
    expect(parseTraefikArgs(['--configFile=/etc/traefik/traefik.yml'])).toHaveProperty('reason');
    expect(parseTraefikArgs(['--providers.kubernetescrd', 'stray'])).toHaveProperty('reason');
    expect(
      parseTraefikArgs(['--providers.kubernetesingressnginx.watchIngressWithoutClass=maybe'])
    ).toHaveProperty('reason');
  });
});

describe('runtimeFromWorkloads', () => {
  it('is unknown with no Traefik, or with several of them', () => {
    expect(runtimeFromWorkloads([]).status).toBe('unknown');
    const two = runtimeFromWorkloads([
      workload(NATIVE_ARGS),
      { ...workload(NATIVE_ARGS), name: 'traefik-internal' },
    ]);
    expect(two.status).toBe('unknown');
    expect(two.status === 'unknown' && two.reason).toContain('traefik-internal');
  });

  it('names the workload it read, with its version', () => {
    const rt = runtimeOf(COMPAT_ARGS);
    expect(rt.status === 'known' && rt.source).toBe('DaemonSet traefik/traefik');
    expect(rt.status === 'known' && rt.version).toEqual({ major: 3, minor: 7, patch: 17 });
  });

  it('is unknown when a configuration file may be mounted over the arguments', () => {
    for (const mount of ['/etc/traefik', '/etc/traefik/', '/config/traefik.yml']) {
      const rt = runtimeFromWorkloads([workload(COMPAT_ARGS, undefined, [mount])]);
      expect(rt.status).toBe('unknown');
    }
    // The chart's dynamic-config directory is not the static file.
    expect(runtimeFromWorkloads([workload(COMPAT_ARGS)]).status).toBe('known');
  });
});

describe('ingressHandling', () => {
  const compat = runtimeOf(COMPAT_ARGS);
  const native = runtimeOf(NATIVE_ARGS);

  it('is unknown for a class-less Ingress the native provider may also serve', () => {
    const both = runtimeOf([
      '--providers.kubernetesingress',
      '--providers.kubernetesingressnginx',
      '--providers.kubernetesingressnginx.watchIngressWithoutClass=true',
    ]);
    expect(ingressHandling(ing(undefined), COMPAT_CLASSES, both).kind).toBe('unknown');
  });

  it('is unknown when no class matches the compatibility provider and it watches class-less ones', () => {
    const rt = runtimeOf([
      '--providers.kubernetesingressnginx',
      '--providers.kubernetesingressnginx.watchIngressWithoutClass=true',
    ]);
    expect(ingressHandling(ing('traefik'), TRAEFIK_CLASSES, rt).kind).toBe('unknown');
  });

  it('is unknown when the serving provider is narrowed by options', () => {
    const rt = runtimeOf([
      ...COMPAT_ARGS,
      '--providers.kubernetesingressnginx.watchNamespace=other',
    ]);
    expect(ingressHandling(ing('public'), COMPAT_CLASSES, rt).kind).toBe('unknown');
  });

  it('sees the beta cluster Ingresses as served by the compatibility provider', () => {
    expect(ingressHandling(ing('public'), COMPAT_CLASSES, compat)).toEqual({
      kind: 'nginx-compat',
    });
    expect(ingressHandling(ing('nginx'), COMPAT_CLASSES, compat)).toEqual({
      kind: 'nginx-compat',
    });
  });

  it('leaves a class-less Ingress alone without watchIngressWithoutClass', () => {
    expect(ingressHandling(ing(undefined), COMPAT_CLASSES, compat).kind).toBe('not-traefik');
  });

  it('serves a Traefik-class Ingress natively', () => {
    expect(ingressHandling(ing('traefik'), TRAEFIK_CLASSES, native)).toEqual({ kind: 'native' });
  });

  it('reports a Traefik-class Ingress as not served when the native provider is off', () => {
    expect(ingressHandling(ing('traefik'), TRAEFIK_CLASSES, compat).kind).toBe('not-traefik');
  });

  it('says unknown rather than guessing', () => {
    const unknown: TraefikRuntime = { status: 'unknown', reason: 'no permission' };
    expect(ingressHandling(ing('public'), COMPAT_CLASSES, unknown)).toEqual({
      kind: 'unknown',
      reason: 'no permission',
    });
    // Class named, but the IngressClass object is not visible.
    expect(ingressHandling(ing('public'), [], compat).kind).toBe('unknown');
    // Class only via the deprecated annotation.
    const legacy = ing(undefined, { 'kubernetes.io/ingress.class': 'nginx' });
    expect(ingressHandling(legacy, COMPAT_CLASSES, compat).kind).toBe('unknown');
    // A class-less Ingress with the native provider on depends on options not read.
    expect(ingressHandling(ing(undefined), TRAEFIK_CLASSES, native).kind).toBe('unknown');
  });

  it('flags an Ingress that both providers would take', () => {
    const dup = runtimeOf([
      ...NATIVE_ARGS,
      '--providers.kubernetesingressnginx',
      '--providers.kubernetesingressnginx.ingressClassByName=true',
      '--providers.kubernetesingressnginx.ingressClass=traefik',
    ]);
    expect(ingressHandling(ing('traefik'), TRAEFIK_CLASSES, dup).kind).toBe('unknown');
  });
});

describe('verdicts', () => {
  const compat = runtimeOf(COMPAT_ARGS);
  const native = runtimeOf(NATIVE_ARGS);
  const nativeNoCrd = runtimeOf(['--providers.kubernetesingress']);
  const unknown: TraefikRuntime = { status: 'unknown', reason: 'no permission' };

  it('refuses both middlewares and access logs on a compatibility-mode Ingress', () => {
    const v = ingressVerdicts(ingressHandling(ing('public'), COMPAT_CLASSES, compat), compat);
    expect(v.middlewares.allowed).toBe('no');
    expect(v.accessLogs.allowed).toBe('no');
  });

  it('allows everything on a native Ingress with the CRD provider on', () => {
    expect(ingressVerdicts({ kind: 'native' }, native)).toEqual({
      middlewares: { allowed: 'yes' },
      accessLogs: { allowed: 'yes' },
    });
  });

  it('refuses middlewares but keeps access logs when only the CRD provider is off', () => {
    const v = ingressVerdicts({ kind: 'native' }, nativeNoCrd);
    expect(v.middlewares.allowed).toBe('no');
    expect(v.accessLogs.allowed).toBe('yes');
  });

  it('asks for confirmation when the state is unknown', () => {
    const v = ingressVerdicts({ kind: 'unknown', reason: 'no permission' }, unknown);
    expect(v.middlewares).toEqual({ allowed: 'confirm', reason: 'no permission' });
    expect(ingressRouteVerdict(unknown).allowed).toBe('confirm');
  });

  it('refuses IngressRoutes without the CRD provider', () => {
    expect(ingressRouteVerdict(compat).allowed).toBe('no');
    expect(ingressRouteVerdict(native).allowed).toBe('yes');
  });

  it('puts a banner on the Middlewares tab unless Traefik reads Middleware objects', () => {
    expect(middlewaresNotice(compat)?.severity).toBe('error');
    expect(middlewaresNotice(unknown)?.severity).toBe('warning');
    expect(middlewaresNotice(native)).toBeNull();
  });
});

describe('nginxProtection', () => {
  const N = 'nginx.ingress.kubernetes.io/';

  it('reads an IP allowlist, basic auth and the HTTPS redirect', () => {
    const p = nginxProtection(
      ing('public', {
        [`${N}whitelist-source-range`]: '10.0.0.0/8, 203.0.113.7/32',
        [`${N}auth-type`]: 'basic',
        [`${N}auth-secret`]: 'panel-auth',
        [`${N}auth-realm`]: 'Panel',
        [`${N}force-ssl-redirect`]: 'true',
      })
    );
    expect(p).toEqual({
      allowlist: ['10.0.0.0/8', '203.0.113.7/32'],
      allowlistEnforced: 'unknown',
      auth: { type: 'basic', secret: 'panel-auth', secretType: 'auth-file', realm: 'Panel' },
      authUrl: null,
      httpsRedirect: 'forced',
      problems: [],
    });
  });

  it('reports the absence of an allowlist and a password plainly', () => {
    const p = nginxProtection(ing('public', {}, true));
    expect(p.allowlist).toBeNull();
    expect(p.auth).toBeNull();
    expect(p.httpsRedirect).toBe('default');
  });

  it('accepts the newer allowlist-source-range name', () => {
    const p = nginxProtection(ing('public', { [`${N}allowlist-source-range`]: '192.168.0.0/16' }));
    expect(p.allowlist).toEqual(['192.168.0.0/16']);
  });

  it('flags half-configured auth and conflicting allowlists', () => {
    const secretOnly = nginxProtection(ing('public', { [`${N}auth-secret`]: 's' }));
    expect(secretOnly.problems).toHaveLength(1);
    expect(secretOnly.auth).toBeNull();
    expect(nginxProtection(ing('public', { [`${N}auth-type`]: 'basic' })).problems).toHaveLength(1);
    const both = nginxProtection(
      ing('public', {
        [`${N}allowlist-source-range`]: '10.0.0.0/8',
        [`${N}whitelist-source-range`]: '0.0.0.0/0',
      })
    );
    expect(both.problems).toHaveLength(1);
  });

  it('reads an explicit ssl-redirect off', () => {
    const p = nginxProtection(ing('public', { [`${N}ssl-redirect`]: 'false' }));
    expect(p.httpsRedirect).toBe('off');
  });
});

describe('buildIngressPatch with sections Traefik does not read', () => {
  const ingress: IngressObject = {
    metadata: {
      name: 'site',
      namespace: 'web',
      resourceVersion: '42',
      annotations: { [ROUTER_MIDDLEWARES_ANNOTATION]: 'web-auth@kubernetescrd' },
    },
  };

  it('leaves the middlewares annotation out when only access logs may be written', () => {
    const patch = buildIngressPatch(ingress, ['auth', 'allow'], ['allow'], 'on', {
      middlewares: false,
      accessLogs: true,
    });
    expect(patch).toEqual({
      metadata: {
        resourceVersion: '42',
        annotations: { [ROUTER_ACCESSLOGS_ANNOTATION]: 'true' },
      },
    });
  });

  it('writes nothing for a section that is not writable', () => {
    const patch = buildIngressPatch(ingress, ['auth'], [], 'on', {
      middlewares: false,
      accessLogs: false,
    });
    expect(patch.metadata.annotations).toEqual({});
  });
});
