import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  basicAuthSecretFor,
  buildHtpasswdSecret,
  buildNginxChange,
  compatSemantics,
  ingressesUsingSecret,
  isOwnIngressSecret,
  nginxEditVerdict,
  nginxFormFromIngress,
  nginxProtection,
  NginxProtectionForm,
  nginxRisks,
  nginxSectionVerdicts,
  saveNginxProtection,
  validateNginxForm,
} from './nginxAnnotations';
import { IngressObject, runtimeFromWorkloads } from './traefik';

// Only saveNginxProtection talks to the API; everything else here is pure.
const api = vi.hoisted(() => ({
  calls: [] as string[],
  secrets: new Map<string, any>(),
  ingress: null as any,
  failPatch: null as Error | null,
  patchLands: false,
}));

vi.mock('@kinvolk/headlamp-plugin/lib/ApiProxy', () => {
  const notFound = () => Object.assign(new Error('not found'), { status: 404 });
  return {
    request: vi.fn(async (url: string, opts?: any) => {
      if (opts?.method === 'PUT') {
        api.calls.push(`PUT ${url}`);
        api.secrets.set(url.split('/').pop()!, JSON.parse(opts.body));
        return {};
      }
      if (opts?.method === 'DELETE') {
        api.calls.push(`DELETE ${url}`);
        api.secrets.delete(url.split('/').pop()!);
        return {};
      }
      api.calls.push(`GET ${url}`);
      if (url.includes('/secrets/')) {
        const s = api.secrets.get(url.split('/').pop()!);
        if (!s) throw notFound();
        return s;
      }
      if (url.includes('/ingresses/')) return api.ingress;
      throw notFound();
    }),
    post: vi.fn(async (url: string, body: any) => {
      api.calls.push(`POST ${url}`);
      api.secrets.set(body.metadata.name, body);
      return body;
    }),
    patch: vi.fn(async (url: string, body: any) => {
      api.calls.push(`PATCH ${url}`);
      if (api.patchLands) {
        api.ingress = {
          ...api.ingress,
          metadata: {
            ...api.ingress.metadata,
            annotations: { ...api.ingress.metadata.annotations, ...body.metadata.annotations },
          },
        };
      }
      if (api.failPatch) throw api.failPatch;
      return {};
    }),
  };
});

const N = 'nginx.ingress.kubernetes.io/';
const OFFICE = '178.183.166.57/32,91.189.30.25/32';

function ing(annotations: Record<string, string> = {}, name = 'crowdsec-ui'): IngressObject {
  return {
    metadata: { name, namespace: 'crowdsec-ui', resourceVersion: '42', annotations },
    spec: { ingressClassName: 'public', rules: [{ host: 'security.example.com' }] },
  };
}

function form(ingress: IngressObject, patch: Partial<NginxProtectionForm> = {}) {
  return { ...nginxFormFromIngress(ingress), ...patch };
}

const decode = (b64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));

describe('nginxFormFromIngress', () => {
  it('starts from what the Ingress has', () => {
    const f = nginxFormFromIngress(
      ing({
        [`${N}whitelist-source-range`]: OFFICE,
        [`${N}auth-type`]: 'basic',
        [`${N}auth-secret`]: 'panel-basic-auth',
        [`${N}auth-realm`]: 'Panel',
        [`${N}force-ssl-redirect`]: 'true',
      })
    );
    expect(f).toEqual({
      allowlist: ['178.183.166.57/32', '91.189.30.25/32'],
      auth: 'keep',
      username: '',
      password: '',
      realm: 'Panel',
      forceHttps: true,
    });
  });
});

describe('buildNginxChange', () => {
  it('changes nothing when the form is saved as loaded', () => {
    const i = ing({ [`${N}whitelist-source-range`]: OFFICE, [`${N}force-ssl-redirect`]: 'true' });
    expect(buildNginxChange(i, nginxFormFromIngress(i))).toEqual({
      annotations: {},
      secret: null,
      dropSecret: null,
    });
  });

  it('adds an address under the annotation name already in use', () => {
    const i = ing({ [`${N}whitelist-source-range`]: OFFICE });
    const f = form(i, { allowlist: [...nginxFormFromIngress(i).allowlist, '1.2.3.4/32'] });
    expect(buildNginxChange(i, f).annotations).toEqual({
      [`${N}whitelist-source-range`]: `${OFFICE},1.2.3.4/32`,
    });
  });

  it('keeps the newer allowlist-source-range name when that is the one set', () => {
    const i = ing({ [`${N}allowlist-source-range`]: '10.0.0.0/8' });
    expect(
      buildNginxChange(i, form(i, { allowlist: ['10.0.0.0/8', '192.168.0.0/16'] })).annotations
    ).toEqual({
      [`${N}allowlist-source-range`]: '10.0.0.0/8,192.168.0.0/16',
    });
  });

  it('writes a new list as whitelist-source-range and clears both names when emptied', () => {
    const none = ing();
    expect(buildNginxChange(none, form(none, { allowlist: ['10.0.0.0/8'] })).annotations).toEqual({
      [`${N}whitelist-source-range`]: '10.0.0.0/8',
    });
    const both = ing({ [`${N}whitelist-source-range`]: 'a', [`${N}allowlist-source-range`]: 'b' });
    expect(buildNginxChange(both, form(both, { allowlist: [] })).annotations).toEqual({
      [`${N}whitelist-source-range`]: null,
      [`${N}allowlist-source-range`]: null,
    });
  });

  it('sets a password as an htpasswd Secret plus the auth annotations', () => {
    const i = ing({ [`${N}whitelist-source-range`]: OFFICE });
    const change = buildNginxChange(
      i,
      form(i, { auth: 'set', username: 'admin', password: 'password', realm: 'Panel' }),
      'abcdefgh'
    );
    expect(change.annotations).toEqual({
      [`${N}auth-type`]: 'basic',
      [`${N}auth-secret`]: 'crowdsec-ui-basic-auth',
      [`${N}auth-realm`]: 'Panel',
    });
    expect(change.secret?.metadata).toEqual({
      name: 'crowdsec-ui-basic-auth',
      namespace: 'crowdsec-ui',
      labels: {
        'app.kubernetes.io/managed-by': 'headlamp-click-ops',
        'click-ops/for-ingress': 'crowdsec-ui',
      },
    });
    // Same line `openssl passwd -apr1 -salt abcdefgh password` gives.
    expect(decode(change.secret!.data.auth)).toBe('admin:$apr1$abcdefgh$FBwExRW4dCc8aL.OvjpIE1\n');
    expect(change.dropSecret).toBeNull();
  });

  it('replaces an auth-map type, which would misread an htpasswd Secret', () => {
    const i = ing({
      [`${N}auth-type`]: 'basic',
      [`${N}auth-secret`]: 'map',
      [`${N}auth-secret-type`]: 'auth-map',
    });
    const change = buildNginxChange(
      i,
      form(i, { auth: 'set', username: 'a', password: 'b' }),
      'abcdefgh'
    );
    expect(change.annotations[`${N}auth-secret-type`]).toBeNull();
    expect(change.annotations[`${N}auth-secret`]).toBe('crowdsec-ui-basic-auth');
  });

  it('drops only its own Secret when the password is switched off', () => {
    const ours = ing({ [`${N}auth-type`]: 'basic', [`${N}auth-secret`]: 'crowdsec-ui-basic-auth' });
    const off = buildNginxChange(ours, form(ours, { auth: 'off' }));
    expect(off.annotations).toEqual({
      [`${N}auth-type`]: null,
      [`${N}auth-secret`]: null,
    });
    expect(off.dropSecret).toBe('crowdsec-ui-basic-auth');

    const foreign = ing({ [`${N}auth-type`]: 'basic', [`${N}auth-secret`]: 'panel-basic-auth' });
    expect(buildNginxChange(foreign, form(foreign, { auth: 'off' })).dropSecret).toBeNull();
    // A Secret in another namespace is never ours, even under our name.
    const elsewhere = ing({
      [`${N}auth-type`]: 'basic',
      [`${N}auth-secret`]: 'other/crowdsec-ui-basic-auth',
    });
    expect(buildNginxChange(elsewhere, form(elsewhere, { auth: 'off' })).dropSecret).toBeNull();
  });

  it('keeping the password touches only the realm', () => {
    const i = ing({ [`${N}auth-type`]: 'basic', [`${N}auth-secret`]: 'panel-basic-auth' });
    const change = buildNginxChange(i, form(i, { realm: 'Panel' }));
    expect(change).toEqual({
      annotations: { [`${N}auth-realm`]: 'Panel' },
      secret: null,
      dropSecret: null,
    });
  });

  it('switches the forced HTTPS redirect on and off', () => {
    const i = ing();
    expect(buildNginxChange(i, form(i, { forceHttps: true })).annotations).toEqual({
      [`${N}force-ssl-redirect`]: 'true',
    });
    const forced = ing({ [`${N}force-ssl-redirect`]: 'true' });
    expect(buildNginxChange(forced, form(forced, { forceHttps: false })).annotations).toEqual({
      [`${N}force-ssl-redirect`]: null,
    });
  });

  it('reads back as the protection the form described', () => {
    const i = ing();
    const f = form(i, {
      allowlist: ['10.0.0.0/8'],
      auth: 'set',
      username: 'admin',
      password: 'x',
      realm: 'Panel',
      forceHttps: true,
    });
    const change = buildNginxChange(i, f, 'abcdefgh');
    const after: IngressObject = {
      ...i,
      metadata: {
        ...i.metadata,
        annotations: Object.fromEntries(
          Object.entries(change.annotations).filter((e): e is [string, string] => e[1] !== null)
        ),
      },
    };
    expect(nginxProtection(after)).toMatchObject({
      allowlist: ['10.0.0.0/8'],
      auth: { type: 'basic', secret: 'crowdsec-ui-basic-auth', realm: 'Panel' },
      httpsRedirect: 'forced',
      problems: [],
    });
  });
});

describe('validateNginxForm', () => {
  const i = ing({ [`${N}whitelist-source-range`]: OFFICE });
  const current = nginxProtection(i);

  it('accepts the form as loaded', () => {
    expect(validateNginxForm(nginxFormFromIngress(i), current, 'crowdsec-ui')).toEqual([]);
  });

  it('rejects bad addresses and incomplete or unsafe credentials', () => {
    expect(validateNginxForm(form(i, { allowlist: ['1.2.3.999'] }), current, 'x')).toHaveLength(1);
    expect(validateNginxForm(form(i, { auth: 'set' }), current, 'x')).toEqual([
      'Username is required.',
      'Password is required.',
    ]);
    expect(
      validateNginxForm(form(i, { auth: 'set', username: 'a:b', password: 'p' }), current, 'x')
    ).toContain('The username cannot contain ":".');
    expect(
      validateNginxForm(form(i, { auth: 'set', username: 'a', password: 'p\nq' }), current, 'x')
    ).toContain('The password cannot contain control characters.');
    expect(
      validateNginxForm(
        form(i, { auth: 'set', username: 'a', password: 'p', realm: 'say "hi"' }),
        current,
        'x'
      )
    ).toContain('The realm cannot contain quotes or backslashes.');
    expect(
      validateNginxForm(
        form(i, { auth: 'set', username: 'a', password: 'p', realm: 'trail\\' }),
        current,
        'x'
      )
    ).toContain('The realm cannot contain quotes or backslashes.');
  });

  it('rejects a username htpasswd would read as a comment', () => {
    expect(
      validateNginxForm(form(i, { auth: 'set', username: '#admin', password: 'p' }), current, 'x')
    ).toContain('The username cannot start with "#" — htpasswd reads such a line as a comment.');
  });

  it('refuses a password for an Ingress whose name cannot be a label value', () => {
    const long = 'a'.repeat(64);
    expect(
      validateNginxForm(form(i, { auth: 'set', username: 'a', password: 'p' }), current, long)
    ).toHaveLength(1);
    expect(
      validateNginxForm(
        form(i, { auth: 'set', username: 'a', password: 'p' }),
        current,
        'a'.repeat(63)
      )
    ).toEqual([]);
  });

  it('cannot keep a password set-up that does not exist', () => {
    expect(validateNginxForm(form(i, { auth: 'keep' }), current, 'x')).toContain(
      'There is no password set-up to keep.'
    );
  });
});

describe('nginxRisks', () => {
  const hosts = ['security.example.com'];
  const protectedIng = ing({
    [`${N}whitelist-source-range`]: OFFICE,
    [`${N}auth-type`]: 'basic',
    [`${N}auth-secret`]: 'p',
    [`${N}force-ssl-redirect`]: 'true',
  });
  const current = nginxProtection(protectedIng);

  it('asks for confirmation before anything is weakened', () => {
    const risks = nginxRisks(
      current,
      form(protectedIng, { allowlist: [], auth: 'off', forceHttps: false }),
      hosts
    );
    expect(risks.map(r => r.level)).toEqual(['confirm', 'confirm', 'confirm']);
    expect(risks[0].text).toContain('security.example.com');
  });

  it('only warns about lock-out when the list is narrowed or introduced', () => {
    const narrowed = nginxRisks(
      current,
      form(protectedIng, { allowlist: ['178.183.166.57/32'] }),
      hosts
    );
    expect(narrowed).toEqual([{ level: 'notice', text: expect.stringContaining('lose access') }]);
    const fresh = ing();
    const introduced = nginxRisks(
      nginxProtection(fresh),
      form(fresh, { allowlist: ['10.0.0.0/8'] }),
      hosts
    );
    expect(introduced.map(r => r.level)).toEqual(['notice']);
  });

  it('is quiet for a change that only adds protection', () => {
    expect(
      nginxRisks(
        current,
        form(protectedIng, { allowlist: [...current.allowlist!, '1.2.3.4/32'] }),
        hosts
      )
    ).toEqual([]);
  });
});

describe('nginxEditVerdict', () => {
  it('allows editing only where the compatibility provider enforces the annotations', () => {
    expect(nginxEditVerdict({ kind: 'nginx-compat' })).toEqual({ allowed: 'yes' });
    expect(nginxEditVerdict({ kind: 'native' }).allowed).toBe('no');
    expect(
      nginxEditVerdict({ kind: 'not-traefik', controller: 'k8s.io/ingress-nginx' }).allowed
    ).toBe('no');
    expect(nginxEditVerdict({ kind: 'unknown', reason: 'r' })).toEqual({
      allowed: 'confirm',
      reason: 'r',
    });
  });
});

describe('Secret ownership', () => {
  it('recognises only Secrets it made for this Ingress', () => {
    const s = buildHtpasswdSecret('crowdsec-ui', 'crowdsec-ui', 'a', 'b', 'abcdefgh');
    expect(s.metadata.name).toBe(basicAuthSecretFor('crowdsec-ui'));
    expect(isOwnIngressSecret(s, 'crowdsec-ui')).toBe(true);
    expect(isOwnIngressSecret(s, 'other')).toBe(false);
    expect(isOwnIngressSecret({ metadata: { labels: {} } }, 'crowdsec-ui')).toBe(false);
  });
});

const runtimeWithImage = (image: string) =>
  runtimeFromWorkloads([
    {
      kind: 'DaemonSet',
      namespace: 'traefik',
      name: 'traefik',
      image,
      args: ['--providers.kubernetesingressnginx'],
      mountPaths: [],
    },
  ]);
const V37 = compatSemantics(runtimeWithImage('docker.io/traefik:v3.7.17'));
const V36 = compatSemantics(runtimeWithImage('rancher/mirrored-library-traefik:3.6.4'));
const VUNKNOWN = compatSemantics(runtimeWithImage('traefik:latest'));

describe('compatSemantics', () => {
  it('follows the Traefik version', () => {
    expect(V37).toEqual({
      allowlist: 'yes',
      sslRedirectDefaultWithTls: true,
      authFailsOpen: false,
      version: '3.7.17',
    });
    expect(V36.allowlist).toBe('no');
    expect(V36.authFailsOpen).toBe(true);
    expect(VUNKNOWN.allowlist).toBe('unknown');
  });
});

describe('nginxProtection, version-aware', () => {
  const withTls = (annotations: Record<string, string>): IngressObject => ({
    ...ing(annotations),
    spec: { ...ing().spec, tls: [{ hosts: ['security.example.com'], secretName: 't' }] },
  });

  it('marks an allowlist Traefik before 3.7 does not enforce', () => {
    const p = nginxProtection(ing({ [`${N}whitelist-source-range`]: OFFICE }), V36);
    expect(p.allowlistEnforced).toBe('no');
    expect(p.problems.join(' ')).toContain('not enforced');
    expect(nginxProtection(ing({ [`${N}whitelist-source-range`]: OFFICE }), V37).problems).toEqual(
      []
    );
  });

  it('knows 3.7 redirects TLS Ingresses by default', () => {
    expect(nginxProtection(withTls({}), V37).httpsRedirect).toBe('default-tls');
    expect(nginxProtection(withTls({}), VUNKNOWN).httpsRedirect).toBe('default');
    expect(nginxProtection(ing(), V37).httpsRedirect).toBe('default');
  });

  it('reads booleans the way 3.7 does: only "true" is on', () => {
    // "1" is not "forced"; with no ssl-redirect either, nothing is said about redirects.
    const p = nginxProtection(ing({ [`${N}force-ssl-redirect`]: '1' }), V37);
    expect(p.httpsRedirect).toBe('default');
    expect(p.problems).toHaveLength(1);
    expect(nginxProtection(ing({ [`${N}ssl-redirect`]: '1' }), V37).httpsRedirect).toBe('off');
    expect(nginxProtection(ing({ [`${N}force-ssl-redirect`]: 'TRUE' })).httpsRedirect).toBe(
      'forced'
    );
    expect(nginxProtection(ing({ [`${N}ssl-redirect`]: 'False' })).problems).toEqual([]);
  });

  it('treats an empty allowlist-source-range as no filtering at all', () => {
    const p = nginxProtection(
      ing({ [`${N}allowlist-source-range`]: '', [`${N}whitelist-source-range`]: '1.2.3.4/32' })
    );
    expect(p.allowlist).toBeNull();
    expect(p.problems.join(' ')).toContain('switches off whitelist-source-range');
  });

  it('flags a list that lets everyone in', () => {
    const p = nginxProtection(ing({ [`${N}whitelist-source-range`]: '1.2.3.4/32,0.0.0.0/0' }));
    expect(p.problems.join(' ')).toContain('0.0.0.0/0');
  });
});

describe('nginxSectionVerdicts', () => {
  const compat = { kind: 'nginx-compat' as const };

  it('allows everything on 3.7', () => {
    expect(nginxSectionVerdicts(compat, V37)).toEqual({
      allowlist: { allowed: 'yes' },
      auth: { allowed: 'yes' },
      https: { allowed: 'yes' },
    });
  });

  it('refuses the allowlist and asks about auth before 3.7', () => {
    const v = nginxSectionVerdicts(compat, V36);
    expect(v.allowlist.allowed).toBe('no');
    expect(v.auth.allowed).toBe('confirm');
    expect(v.https.allowed).toBe('yes');
  });

  it('asks about the allowlist when the version is unknown', () => {
    expect(nginxSectionVerdicts(compat, VUNKNOWN).allowlist.allowed).toBe('confirm');
  });

  it('passes a refusal of the whole Ingress to every section', () => {
    const v = nginxSectionVerdicts({ kind: 'native' }, V37);
    expect([v.allowlist.allowed, v.auth.allowed, v.https.allowed]).toEqual(['no', 'no', 'no']);
  });
});

describe('buildNginxChange leaves untouched sections alone', () => {
  it('does not rewrite a value the user did not change', () => {
    const i = ing({
      [`${N}whitelist-source-range`]: '1.2.3.4/32, 5.6.7.8/32',
      [`${N}force-ssl-redirect`]: '1',
      [`${N}auth-secret`]: 'half-configured',
    });
    expect(buildNginxChange(i, nginxFormFromIngress(i))).toEqual({
      annotations: {},
      secret: null,
      dropSecret: null,
    });
  });

  it('keeps its own Secret when another Ingress still uses it', () => {
    const i = ing({ [`${N}auth-type`]: 'basic', [`${N}auth-secret`]: 'crowdsec-ui-basic-auth' });
    expect(
      buildNginxChange(i, form(i, { auth: 'off' }), undefined, ['other']).dropSecret
    ).toBeNull();
  });
});

describe('ingressesUsingSecret and the shared-Secret risks', () => {
  const ours = 'crowdsec-ui-basic-auth';
  const others: IngressObject[] = [
    ing({ [`${N}auth-secret`]: ours }, 'second'),
    ing({ [`${N}auth-secret`]: `crowdsec-ui/${ours}` }, 'third'),
    ing({ [`${N}auth-secret`]: 'something-else' }, 'fourth'),
    ing({ [`${N}auth-secret`]: ours }, 'crowdsec-ui'),
  ];

  it('finds the other Ingresses pointing at the Secret, by plain or namespaced name', () => {
    expect(ingressesUsingSecret(others, 'crowdsec-ui', ours, 'crowdsec-ui')).toEqual([
      'second',
      'third',
    ]);
  });

  it('asks before changing a password others share, and says why the Secret stays', () => {
    const i = ing({ [`${N}auth-type`]: 'basic', [`${N}auth-secret`]: ours });
    const current = nginxProtection(i);
    const set = nginxRisks(
      current,
      form(i, { auth: 'set', username: 'a', password: 'b' }),
      [],
      ['second']
    );
    expect(set).toContainEqual({ level: 'confirm', text: expect.stringContaining('second') });
    const off = nginxRisks(current, form(i, { auth: 'off' }), [], ['second']);
    expect(off).toContainEqual({ level: 'notice', text: expect.stringContaining('stays') });
  });

  it('asks before an allowlist entry that lets everyone in', () => {
    const i = ing({ [`${N}whitelist-source-range`]: '1.2.3.4/32' });
    const risks = nginxRisks(
      nginxProtection(i),
      form(i, { allowlist: ['1.2.3.4/32', '0.0.0.0/0'] }),
      []
    );
    expect(risks.map(r => r.level)).toEqual(['confirm']);
  });
});

describe('saveNginxProtection', () => {
  const NS = '/api/v1/namespaces/crowdsec-ui/secrets';
  const ING = '/apis/networking.k8s.io/v1/namespaces/crowdsec-ui/ingresses/crowdsec-ui';
  const conflict = () => Object.assign(new Error('Conflict'), { status: 409 });

  beforeEach(() => {
    api.calls.length = 0;
    api.secrets.clear();
    api.failPatch = null;
    api.patchLands = false;
  });

  it('writes a new Secret before pointing the Ingress at it', async () => {
    const i = ing({ [`${N}whitelist-source-range`]: OFFICE });
    api.ingress = i;
    await saveNginxProtection(
      i,
      buildNginxChange(i, form(i, { auth: 'set', username: 'a', password: 'b' }))
    );
    expect(api.calls).toEqual([`GET ${NS}/crowdsec-ui-basic-auth`, `POST ${NS}`, `PATCH ${ING}`]);
  });

  it('rolls a fresh Secret back when the patch is refused and nothing points at it', async () => {
    const i = ing();
    api.ingress = i;
    api.failPatch = conflict();
    await expect(
      saveNginxProtection(
        i,
        buildNginxChange(i, form(i, { auth: 'set', username: 'a', password: 'b' }))
      )
    ).rejects.toThrow(/changed by someone else/);
    expect(api.calls).toContain(`DELETE ${NS}/crowdsec-ui-basic-auth`);
  });

  it('keeps a fresh Secret when a failed patch landed after all', async () => {
    const i = ing();
    api.ingress = i;
    api.patchLands = true;
    api.failPatch = new Error('timeout');
    await expect(
      saveNginxProtection(
        i,
        buildNginxChange(i, form(i, { auth: 'set', username: 'a', password: 'b' }))
      )
    ).rejects.toThrow('timeout');
    expect(api.calls.some(c => c.startsWith('DELETE'))).toBe(false);
    expect(api.secrets.has('crowdsec-ui-basic-auth')).toBe(true);
  });

  it('changes a Secret already in use only after the patch went through', async () => {
    const ours = buildHtpasswdSecret('crowdsec-ui', 'crowdsec-ui', 'old', 'old', 'abcdefgh');
    api.secrets.set(ours.metadata.name, ours);
    const i = ing({ [`${N}auth-type`]: 'basic', [`${N}auth-secret`]: ours.metadata.name });
    api.ingress = i;
    api.failPatch = conflict();
    const change = buildNginxChange(
      i,
      form(i, { auth: 'set', username: 'new', password: 'new', realm: 'Panel' })
    );
    await expect(saveNginxProtection(i, change)).rejects.toThrow(/changed by someone else/);
    expect(api.calls.some(c => c.startsWith('PUT'))).toBe(false);
    expect(decode(api.secrets.get(ours.metadata.name).data.auth)).toMatch(/^old:/);
  });

  it('refuses to overwrite a Secret it did not make', async () => {
    api.secrets.set('crowdsec-ui-basic-auth', { metadata: { name: 'crowdsec-ui-basic-auth' } });
    const i = ing();
    api.ingress = i;
    await expect(
      saveNginxProtection(
        i,
        buildNginxChange(i, form(i, { auth: 'set', username: 'a', password: 'b' }))
      )
    ).rejects.toThrow(/not created for this Ingress/);
    expect(api.calls.some(c => !c.startsWith('GET'))).toBe(false);
  });
});
