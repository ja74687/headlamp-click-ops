import { Icon } from '@iconify/react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  InputAdornment,
  LinearProgress,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import yaml from 'js-yaml';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getSecret } from './lib/kvResources';
import {
  basicAuthSecretFor,
  buildNginxChange,
  compatSemantics,
  ingressesUsingSecret,
  isOwnIngressSecret,
  NGINX_PREFIX,
  nginxFormFromIngress,
  nginxProtection,
  NginxProtectionForm,
  nginxRisks,
  nginxSectionVerdicts,
  saveNginxProtection,
  validateNginxForm,
} from './lib/nginxAnnotations';
import {
  IngressHandling,
  ingressHosts,
  IngressObject,
  isValidSourceRange,
  LOCALHOST_RANGES,
  PRIVATE_RANGES,
  TraefikRuntime,
  Verdict,
} from './lib/traefik';
import { ListInput, splitEntries } from './TraefikMiddlewareFields';
import YamlPreview from './YamlPreview';

export type NginxTarget = { ingress: IngressObject; handling: IngressHandling };

/** Whether the Secret auth-secret points at was made by this page; null when not known. */
type SecretOrigin = 'loading' | 'own' | 'foreign' | null;

type Section = 'allowlist' | 'auth' | 'https';

// The preview hashes a placeholder with a fixed salt: the hash is masked anyway, and the real
// password is only hashed once, with a random salt, when saving.
const PREVIEW_SALT = 'preview0';
const PREVIEW_PASSWORD = 'x';

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `name` or `namespace/name`, as auth-secret accepts both. */
function secretRef(value: string, ingressNamespace: string): { namespace: string; name: string } {
  const slash = value.indexOf('/');
  return slash === -1
    ? { namespace: ingressNamespace, name: value }
    : { namespace: value.slice(0, slash), name: value.slice(slash + 1) };
}

function cleanList(values: string[]): string[] {
  return values.map(v => v.trim()).filter(v => v.length > 0);
}

/**
 * The form as it will be saved: a section the running Traefik does not act on keeps its
 * initial values, so nothing in it reaches the change whatever the fields show.
 */
function effectiveForm(
  form: NginxProtectionForm,
  initial: NginxProtectionForm,
  verdicts: Record<Section, Verdict>
): NginxProtectionForm {
  const next = { ...form };
  if (verdicts.allowlist.allowed === 'no') next.allowlist = initial.allowlist;
  if (verdicts.auth.allowed === 'no') {
    next.auth = initial.auth;
    next.username = initial.username;
    next.password = initial.password;
    next.realm = initial.realm;
  }
  if (verdicts.https.allowed === 'no') next.forceHttps = initial.forceHttps;
  return next;
}

/** Which sections the form changes compared with the Ingress as loaded. */
function changedSections(
  form: NginxProtectionForm,
  initial: NginxProtectionForm
): Record<Section, boolean> {
  const a = cleanList(form.allowlist);
  const b = cleanList(initial.allowlist);
  return {
    allowlist: a.length !== b.length || a.some((v, i) => v !== b[i]),
    auth:
      form.auth !== initial.auth ||
      form.auth === 'set' ||
      (form.auth !== 'off' && form.realm.trim() !== initial.realm.trim()),
    https: form.forceHttps !== initial.forceHttps,
  };
}

/** A section's verdict inside it: the reason for "no" (locked) or "confirm" (needs a tick). */
function SectionVerdict({ verdict }: { verdict: Verdict }) {
  if (verdict.allowed === 'yes') return null;
  return (
    <Alert severity={verdict.allowed === 'no' ? 'error' : 'warning'} sx={{ mb: 1 }}>
      {verdict.reason}
    </Alert>
  );
}

export default function NginxProtectionDialog({
  target,
  runtime,
  ingresses,
  onClose,
  onSaved,
}: {
  target: NginxTarget | null;
  runtime: TraefikRuntime;
  /** The listed Ingresses, to tell whether this one's password Secret is shared. */
  ingresses: IngressObject[];
  onClose: () => void;
  onSaved: (notice: string) => Promise<void>;
}) {
  const ingress = target?.ingress ?? null;
  const [form, setForm] = useState<NginxProtectionForm | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [risksConfirmed, setRisksConfirmed] = useState(false);
  const [verdictConfirmed, setVerdictConfirmed] = useState(false);
  const [secretOrigin, setSecretOrigin] = useState<SecretOrigin>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const semantics = useMemo(() => compatSemantics(runtime), [runtime]);
  const current = useMemo(
    () => (ingress ? nginxProtection(ingress, semantics) : null),
    [ingress, semantics]
  );
  const initial = useMemo(() => (ingress ? nginxFormFromIngress(ingress) : null), [ingress]);
  const verdicts = useMemo(
    () => (target ? nginxSectionVerdicts(target.handling, semantics) : null),
    [target, semantics]
  );
  const sharedWith = useMemo(
    () =>
      ingress
        ? ingressesUsingSecret(
            ingresses,
            ingress.metadata.namespace,
            basicAuthSecretFor(ingress.metadata.name),
            ingress.metadata.name
          )
        : [],
    [ingress, ingresses]
  );

  // Initialise once per opened Ingress, so a reload behind the dialog does not reset the form.
  const initialisedFor = useRef<NginxTarget | null>(null);
  const lookupToken = useRef(0);
  useEffect(() => {
    if (target === initialisedFor.current) return;
    initialisedFor.current = target;
    const token = ++lookupToken.current;
    setError(null);
    setShowPassword(false);
    setRisksConfirmed(false);
    setVerdictConfirmed(false);
    setSecretOrigin(null);
    if (!target) {
      setForm(null);
      return;
    }
    setForm(nginxFormFromIngress(target.ingress));
    const secret = nginxProtection(target.ingress).auth?.secret;
    if (!secret) return;
    const ref = secretRef(secret, target.ingress.metadata.namespace);
    setSecretOrigin('loading');
    // A failed read claims neither: getSecret returns null for that, as for a missing Secret.
    getSecret(ref.namespace, ref.name).then(s => {
      if (token !== lookupToken.current) return;
      setSecretOrigin(
        s === null ? null : isOwnIngressSecret(s, target.ingress.metadata.name) ? 'own' : 'foreign'
      );
    });
  }, [target]);

  const effective = useMemo(
    () => (form && initial && verdicts ? effectiveForm(form, initial, verdicts) : null),
    [form, initial, verdicts]
  );

  const errors = useMemo(
    () =>
      ingress && effective && current
        ? validateNginxForm(effective, current, ingress.metadata.name)
        : [],
    [ingress, effective, current]
  );
  const risks = useMemo(
    () =>
      ingress && effective && current
        ? nginxRisks(current, effective, ingressHosts(ingress), sharedWith)
        : [],
    [ingress, effective, current, sharedWith]
  );
  const confirmRisks = risks.filter(r => r.level === 'confirm');
  const noticeRisks = risks.filter(r => r.level === 'notice');
  // An acknowledgement covers the risks it was given for; a new one needs a new tick.
  const confirmKey = confirmRisks.map(r => r.text).join('|');
  useEffect(() => {
    setRisksConfirmed(false);
  }, [confirmKey]);

  // A "confirm" verdict gates the save only for a section the form actually changes.
  const changed = effective && initial ? changedSections(effective, initial) : null;
  const doubts =
    verdicts && changed
      ? [
          ...new Set(
            (['allowlist', 'auth', 'https'] as Section[]).flatMap(s => {
              const v = verdicts[s];
              return changed[s] && v.allowed === 'confirm' ? [v.reason] : [];
            })
          ),
        ]
      : [];
  const doubtKey = doubts.join('|');
  useEffect(() => {
    setVerdictConfirmed(false);
  }, [doubtKey]);

  const preview = useMemo(() => {
    if (!ingress || !effective || errors.length > 0) return null;
    const change = buildNginxChange(
      ingress,
      { ...effective, password: effective.password ? PREVIEW_PASSWORD : '' },
      PREVIEW_SALT,
      sharedWith
    );
    const hasChanges =
      Object.keys(change.annotations).length > 0 || change.secret !== null || !!change.dropSecret;
    const dump = (o: object) => yaml.dump(o, { noRefs: true, lineWidth: -1 });
    const docs: string[] = [];
    if (change.secret) {
      docs.push(
        '# Written first\n' +
          dump({ ...change.secret, data: { auth: '*** (apr1 hash, not shown)' } })
      );
    }
    if (Object.keys(change.annotations).length > 0) {
      docs.push(
        `# Ingress ${ingress.metadata.namespace}/${ingress.metadata.name} — null removes an annotation\n` +
          dump({ metadata: { annotations: change.annotations } })
      );
    }
    if (change.dropSecret) {
      docs.push(`# Then Secret ${change.dropSecret} is deleted, if it was created here\n`);
    }
    return { hasChanges, yaml: docs.join('---\n') };
  }, [ingress, effective, errors.length, sharedWith]);

  const allNo =
    !!verdicts &&
    verdicts.allowlist.allowed === 'no' &&
    verdicts.auth.allowed === 'no' &&
    verdicts.https.allowed === 'no';
  const canSave =
    !busy &&
    !allNo &&
    !!preview?.hasChanges &&
    errors.length === 0 &&
    (confirmRisks.length === 0 || risksConfirmed) &&
    (doubts.length === 0 || verdictConfirmed);

  async function save() {
    if (!ingress || !effective || !canSave) return;
    setBusy(true);
    setError(null);
    try {
      await saveNginxProtection(
        ingress,
        buildNginxChange(ingress, effective, undefined, sharedWith)
      );
      await onSaved('Saved — Traefik applies it within a few seconds.');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const set = (patch: Partial<NginxProtectionForm>) => setForm(f => (f ? { ...f, ...patch } : f));
  const sslRedirect = ingress?.metadata.annotations?.[`${NGINX_PREFIX}ssl-redirect`];
  // When every section is refused for the same reason, say it once instead of three times.
  const sameRefusal =
    allNo &&
    !!verdicts &&
    verdicts.allowlist.allowed === 'no' &&
    verdicts.auth.allowed === 'no' &&
    verdicts.allowlist.reason === verdicts.auth.reason;
  const sectionVerdict = (v: Verdict) => (sameRefusal ? null : <SectionVerdict verdict={v} />);

  return (
    <Dialog open={target !== null} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        Protection of Ingress {ingress?.metadata.namespace}/{ingress?.metadata.name}
      </DialogTitle>
      <DialogContent dividers>
        {ingress && form && current && verdicts && (
          <Stack spacing={2}>
            <Typography variant="caption" color="text.secondary">
              Traefik's ingress-nginx compatibility provider enforces these{' '}
              <code>nginx.ingress.kubernetes.io</code> annotations on this Ingress — the same change{' '}
              <code>kubectl annotate --overwrite</code> would make.
              {semantics.version && ` Running Traefik ${semantics.version}.`}
            </Typography>

            {sameRefusal && verdicts.allowlist.allowed === 'no' && (
              <Alert severity="error">{verdicts.allowlist.reason}</Alert>
            )}

            {current.problems.map((p, i) => (
              <Alert severity="warning" key={i}>
                {p}
              </Alert>
            ))}

            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>
                IP allowlist
              </Typography>
              {sectionVerdict(verdicts.allowlist)}
              <ListInput
                label="Allowed addresses and networks"
                values={form.allowlist}
                onChange={allowlist => set({ allowlist })}
                options={[...PRIVATE_RANGES, ...LOCALHOST_RANGES]}
                isValid={isValidSourceRange}
                placeholder="203.0.113.7 or 10.0.0.0/8"
                helperText="IPv4 or IPv6, a single address or a CIDR network. An empty list lets every address in."
                disabled={verdicts.allowlist.allowed === 'no'}
              />
              <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
                <Button
                  size="small"
                  startIcon={<Icon icon="mdi:plus" />}
                  disabled={verdicts.allowlist.allowed === 'no'}
                  onClick={() =>
                    set({ allowlist: splitEntries([...form.allowlist, ...PRIVATE_RANGES]) })
                  }
                >
                  Private networks
                </Button>
                <Button
                  size="small"
                  startIcon={<Icon icon="mdi:plus" />}
                  disabled={verdicts.allowlist.allowed === 'no'}
                  onClick={() =>
                    set({ allowlist: splitEntries([...form.allowlist, ...LOCALHOST_RANGES]) })
                  }
                >
                  Localhost
                </Button>
              </Stack>
            </Box>

            <Box>
              <Typography variant="subtitle2">Password</Typography>
              {sectionVerdict(verdicts.auth)}
              <RadioGroup
                value={form.auth}
                onChange={e => set({ auth: e.target.value as NginxProtectionForm['auth'] })}
              >
                <FormControlLabel
                  value="off"
                  disabled={verdicts.auth.allowed === 'no'}
                  control={<Radio size="small" />}
                  label="No password"
                />
                <FormControlLabel
                  value="keep"
                  disabled={!current.auth || verdicts.auth.allowed === 'no'}
                  control={<Radio size="small" />}
                  label={
                    current.auth ? (
                      <Stack
                        direction="row"
                        spacing={1}
                        alignItems="center"
                        flexWrap="wrap"
                        useFlexGap
                      >
                        <span>Keep current:</span>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                          {current.auth.type} auth · Secret {current.auth.secret ?? '(missing)'}
                        </Typography>
                        {secretOrigin === 'own' && (
                          <Chip size="small" variant="outlined" label="created here" />
                        )}
                        {secretOrigin === 'foreign' && (
                          <Chip size="small" variant="outlined" label="not created here" />
                        )}
                      </Stack>
                    ) : (
                      'Keep current (none set)'
                    )
                  }
                />
                <FormControlLabel
                  value="set"
                  disabled={verdicts.auth.allowed === 'no'}
                  control={<Radio size="small" />}
                  label="Set a new user"
                />
              </RadioGroup>

              {form.auth === 'set' && (
                <Stack spacing={1.5} sx={{ mt: 1 }}>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                    <TextField
                      size="small"
                      label="Username"
                      value={form.username}
                      onChange={e => set({ username: e.target.value })}
                      autoComplete="off"
                      disabled={verdicts.auth.allowed === 'no'}
                      sx={{ flex: 1 }}
                    />
                    <TextField
                      size="small"
                      label="Password"
                      type={showPassword ? 'text' : 'password'}
                      value={form.password}
                      onChange={e => set({ password: e.target.value })}
                      autoComplete="new-password"
                      disabled={verdicts.auth.allowed === 'no'}
                      sx={{ flex: 1 }}
                      InputProps={{
                        endAdornment: (
                          <InputAdornment position="end">
                            <Tooltip title={showPassword ? 'Hide password' : 'Show password'}>
                              <IconButton
                                size="small"
                                aria-label={showPassword ? 'Hide password' : 'Show password'}
                                onClick={() => setShowPassword(s => !s)}
                              >
                                <Icon
                                  icon={showPassword ? 'mdi:eye-off-outline' : 'mdi:eye-outline'}
                                />
                              </IconButton>
                            </Tooltip>
                          </InputAdornment>
                        ),
                      }}
                    />
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    One user. The password is stored as an apr1 htpasswd hash in Secret{' '}
                    <code>{basicAuthSecretFor(ingress.metadata.name)}</code>. Replacing a password
                    set up elsewhere leaves that other Secret untouched. ASCII passwords are safest:
                    clients encode non-ASCII Basic-auth credentials differently.
                  </Typography>
                </Stack>
              )}

              {form.auth !== 'off' && (
                <TextField
                  size="small"
                  label="Realm"
                  value={form.realm}
                  onChange={e => set({ realm: e.target.value })}
                  helperText="Optional. The name some browsers show in the login prompt."
                  disabled={verdicts.auth.allowed === 'no'}
                  sx={{ mt: 1.5, maxWidth: 420 }}
                  fullWidth
                />
              )}
            </Box>

            <Box>
              <Typography variant="subtitle2">HTTPS</Typography>
              {sectionVerdict(verdicts.https)}
              <FormControlLabel
                disabled={verdicts.https.allowed === 'no'}
                control={
                  <Checkbox
                    size="small"
                    checked={form.forceHttps}
                    onChange={e => set({ forceHttps: e.target.checked })}
                  />
                }
                label="Always redirect HTTP to HTTPS (force-ssl-redirect)"
              />
              {current.httpsRedirect === 'default-tls' && !form.forceHttps && (
                <Typography variant="caption" color="text.secondary" component="div">
                  Without it, Traefik {semantics.version} still redirects this Ingress, because it
                  has TLS.
                </Typography>
              )}
              {sslRedirect !== undefined && (
                <Typography variant="caption" color="text.secondary" component="div">
                  This Ingress also sets <code>ssl-redirect: "{sslRedirect}"</code>, which this
                  dialog leaves as it is.
                </Typography>
              )}
            </Box>

            {errors.length > 0 && (
              <Alert severity="info">
                {errors.map(e => (
                  <div key={e}>{e}</div>
                ))}
              </Alert>
            )}

            {noticeRisks.length > 0 && (
              <Alert severity="info">
                {noticeRisks.map(r => (
                  <div key={r.text}>{r.text}</div>
                ))}
              </Alert>
            )}
            {confirmRisks.length > 0 && (
              <Alert severity="warning">
                {confirmRisks.map(r => (
                  <div key={r.text}>{r.text}</div>
                ))}
                <FormControlLabel
                  sx={{ display: 'flex', mt: 1 }}
                  control={
                    <Checkbox
                      size="small"
                      checked={risksConfirmed}
                      onChange={e => setRisksConfirmed(e.target.checked)}
                    />
                  }
                  label="I understand"
                />
              </Alert>
            )}
            {doubts.length > 0 && (
              <Alert severity="warning">
                {doubts.map(d => (
                  <div key={d}>{d}</div>
                ))}
                <FormControlLabel
                  sx={{ display: 'flex', mt: 1 }}
                  control={
                    <Checkbox
                      size="small"
                      checked={verdictConfirmed}
                      onChange={e => setVerdictConfirmed(e.target.checked)}
                    />
                  }
                  label="I've checked that Traefik reads this — save anyway"
                />
              </Alert>
            )}

            {preview && preview.hasChanges && (
              <YamlPreview
                title="Change to apply"
                caption="The password and its hash are never shown."
                yaml={preview.yaml}
                maxHeight={240}
              />
            )}
            {preview && !preview.hasChanges && !allNo && (
              <Typography variant="body2" color="text.secondary">
                Nothing changed yet.
              </Typography>
            )}

            {error && (
              <Alert severity="error" onClose={() => setError(null)}>
                {error}
              </Alert>
            )}
            {busy && <LinearProgress />}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {allNo ? 'Close' : 'Cancel'}
        </Button>
        {!allNo && (
          <Button variant="contained" onClick={save} disabled={!canSave}>
            Save
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
