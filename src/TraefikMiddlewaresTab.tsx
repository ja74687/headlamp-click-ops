import { Icon } from '@iconify/react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  CardActionArea,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import yaml from 'js-yaml';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  basicAuthSecretName,
  buildBasicAuthSecret,
  buildMiddleware,
  deleteMiddleware,
  detectType,
  emptyForm,
  formFromMiddleware,
  isClickOpsManaged,
  isFormEditable,
  lookupBasicAuthSecret,
  MIDDLEWARE_TYPES,
  MiddlewareForm,
  MiddlewareObject,
  middlewaresNotice,
  middlewareUsers,
  saveMiddleware,
  shouldWriteBasicAuthSecret,
  summarizeMiddleware,
  TraefikData,
  TraefikRuntime,
  typeLabel,
  validateMiddlewareForm,
} from './lib/traefik';
import TraefikMiddlewareFields from './TraefikMiddlewareFields';
import YamlPreview from './YamlPreview';

type Mode = { kind: 'create' } | { kind: 'edit'; live: MiddlewareObject };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function previewYaml(form: MiddlewareForm, live: MiddlewareObject | null): string {
  const docs: object[] = [];
  if (shouldWriteBasicAuthSecret(form, !live)) {
    const secret = buildBasicAuthSecret(
      form.name,
      form.namespace,
      live ? form.basicAuth.secretName : basicAuthSecretName(form.name),
      '',
      ''
    );
    docs.push({ ...secret, data: { username: '***', password: '***' } });
  }
  docs.push(buildMiddleware(form, live));
  return docs.map(d => yaml.dump(d, { noRefs: true, lineWidth: -1 })).join('---\n');
}

export default function TraefikMiddlewaresTab({
  data,
  runtime,
  loading,
  activeNamespaces,
  namespaceOptions,
  onChanged,
}: {
  data: TraefikData;
  runtime: TraefikRuntime;
  loading: boolean;
  activeNamespaces: string[];
  namespaceOptions: string[];
  onChanged: () => Promise<void>;
}) {
  const defaultNamespace = activeNamespaces[0] ?? 'default';
  const [mode, setMode] = useState<Mode>({ kind: 'create' });
  const [form, setForm] = useState<MiddlewareForm>(() => emptyForm(defaultNamespace));
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [credentialsNote, setCredentialsNote] = useState<string | null>(null);
  // Bumped on every edit start and reset, so a late Secret lookup for a middleware the form
  // has since moved away from (same name in another namespace included) is dropped.
  const lookupToken = useRef(0);

  const live = mode.kind === 'edit' ? mode.live : null;
  const creating = live === null;

  // Repeated above the list and above the form: a middleware built here is no protection at
  // all when Traefik does not read Middleware objects.
  const notice = middlewaresNotice(runtime);
  const noticeAlert = notice && <Alert severity={notice.severity}>{notice.text}</Alert>;

  function resetForm(namespace = defaultNamespace) {
    lookupToken.current += 1;
    setMode({ kind: 'create' });
    setForm(emptyForm(namespace));
    setError(null);
    setCredentialsNote(null);
  }

  // Follow the topbar filter: a new middleware goes into the namespace being looked at, and
  // an edit of something now filtered out is abandoned rather than left dangling.
  useEffect(() => {
    if (activeNamespaces.length === 0) return;
    if (mode.kind === 'edit') {
      if (!activeNamespaces.includes(mode.live.metadata.namespace)) resetForm(activeNamespaces[0]);
      return;
    }
    if (!activeNamespaces.includes(form.namespace)) {
      setForm(f => ({ ...f, namespace: activeNamespaces[0] }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNamespaces.join(',')]);

  async function startEdit(mw: MiddlewareObject) {
    const token = ++lookupToken.current;
    setMode({ kind: 'edit', live: mw });
    const next = formFromMiddleware(mw);
    setForm(next);
    setError(null);
    setSuccess(null);
    setWarning(null);
    setCredentialsNote(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (next.type !== 'basicAuth' || !next.basicAuth.secretName) return;
    try {
      const info = await lookupBasicAuthSecret(
        mw.metadata.namespace,
        next.basicAuth.secretName,
        mw.metadata.name
      );
      if (token !== lookupToken.current) return;
      if (!info.exists) {
        setCredentialsNote(
          `Secret ${next.basicAuth.secretName} does not exist, so nobody can log in through this middleware.`
        );
      }
      setForm(f => ({
        ...f,
        basicAuth: {
          ...f.basicAuth,
          credentialsManaged: info.managed,
          existingUsername: info.username,
          username: info.managed ? info.username ?? '' : '',
        },
      }));
    } catch (err) {
      if (token !== lookupToken.current) return;
      setCredentialsNote(`Could not read Secret ${next.basicAuth.secretName}: ${errText(err)}`);
    }
  }

  const liveTypeSpec = live?.spec?.[form.type];
  const errors = validateMiddlewareForm(form, creating, liveTypeSpec);
  const yamlText = useMemo(
    () => (errors.length === 0 ? previewYaml(form, live) : ''),
    // errors is derived from form and live
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [form, live, errors.length]
  );

  async function save() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    setWarning(null);
    try {
      const { pruned } = await saveMiddleware(form, live);
      if (pruned.length === 0) {
        setSuccess(`Middleware ${form.namespace}/${form.name} saved.`);
      } else {
        setWarning(
          `Middleware ${form.namespace}/${form.name} was saved, but the API server dropped ` +
            `${pruned.join(', ')}: the Traefik CRDs installed here don't know ` +
            `${pruned.length === 1 ? 'that field' : 'those fields'}. Traefik or its CRDs are ` +
            'probably too old — v2.10/2.11 serve traefik.io too, but call the allowlist ' +
            'ipWhiteList. The middleware does not do what the form says until the CRDs are upgraded.'
        );
      }
      resetForm(form.namespace);
      await onChanged();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(mw: MiddlewareObject) {
    const users = middlewareUsers(mw, data.ingresses, data.ingressRoutes, data.middlewares);
    const scope = 'in the namespaces currently shown';
    const usedBy =
      users.length > 0
        ? `\n\nStill used ${scope} by ${users
            .map(u => `${u.kind} ${u.namespace}/${u.name}`)
            .join(', ')} — Traefik reports those as broken until the reference is removed.`
        : `\n\nNothing ${scope} uses it.`;
    if (
      !window.confirm(`Delete Middleware ${mw.metadata.namespace}/${mw.metadata.name}?${usedBy}`)
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await deleteMiddleware(mw, data.middlewares);
      if (
        live &&
        live.metadata.name === mw.metadata.name &&
        live.metadata.namespace === mw.metadata.namespace
      ) {
        resetForm();
      }
      await onChanged();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const q = filter.trim().toLowerCase();
  const visible = data.middlewares.filter(
    m =>
      !q ||
      m.metadata.name.toLowerCase().includes(q) ||
      m.metadata.namespace.toLowerCase().includes(q)
  );

  return (
    <Stack spacing={3}>
      {noticeAlert}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Typography variant="h6">Middlewares</Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            {loading && <CircularProgress size={18} />}
            <Tooltip title="Refresh">
              <IconButton onClick={onChanged} size="small" aria-label="Refresh">
                <Icon icon="mdi:refresh" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
        <TextField
          size="small"
          label="Filter name"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          fullWidth
          sx={{ mb: 1 }}
        />
        {visible.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
            No Middlewares here yet. Build one with the form below.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>What it does</TableCell>
                <TableCell>Used by</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {visible.map(m => {
                const users = middlewareUsers(
                  m,
                  data.ingresses,
                  data.ingressRoutes,
                  data.middlewares
                );
                const editable = isFormEditable(m);
                return (
                  <TableRow hover key={`${m.metadata.namespace}/${m.metadata.name}`}>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                        {m.metadata.name}
                      </Typography>
                      <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
                        <Chip size="small" label={m.metadata.namespace} />
                        {isClickOpsManaged(m) && (
                          <Chip size="small" variant="outlined" label="click-ops" />
                        )}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2">{typeLabel(detectType(m.spec))}</Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {summarizeMiddleware(m)}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      {users.length === 0 ? (
                        <Typography variant="caption" color="text.secondary">
                          not attached
                        </Typography>
                      ) : (
                        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                          {users.map(u => (
                            <Chip
                              key={`${u.kind}/${u.namespace}/${u.name}`}
                              size="small"
                              variant="outlined"
                              label={`${u.kind === 'Middleware' ? 'chain ' : ''}${
                                u.namespace === m.metadata.namespace
                                  ? u.name
                                  : `${u.namespace}/${u.name}`
                              }`}
                              title={u.kind}
                            />
                          ))}
                        </Stack>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                        <Tooltip
                          title={
                            editable ? 'Edit' : 'This kind of middleware can only be edited as YAML'
                          }
                        >
                          <span>
                            <IconButton
                              size="small"
                              onClick={() => startEdit(m)}
                              disabled={!editable || busy}
                              aria-label="Edit middleware"
                            >
                              <Icon icon="mdi:pencil-outline" />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title="Delete">
                          <span>
                            <IconButton
                              size="small"
                              color="error"
                              onClick={() => remove(m)}
                              disabled={busy}
                              aria-label="Delete middleware"
                            >
                              <Icon icon="mdi:delete-outline" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Paper>

      {noticeAlert}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="h6">
            {live ? `Editing ${live.metadata.namespace}/${live.metadata.name}` : 'New middleware'}
          </Typography>
          {live && (
            <Button size="small" startIcon={<Icon icon="mdi:plus" />} onClick={() => resetForm()}>
              New middleware
            </Button>
          )}
        </Stack>

        {creating ? (
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', lg: 'repeat(3, 1fr)' },
              gap: 1,
              mb: 2,
            }}
          >
            {MIDDLEWARE_TYPES.map(t => {
              const selected = form.type === t.type;
              return (
                <Paper
                  key={t.type}
                  variant="outlined"
                  sx={{
                    borderColor: selected ? 'primary.main' : 'divider',
                    borderWidth: selected ? 2 : 1,
                  }}
                >
                  <CardActionArea
                    onClick={() => setForm(f => ({ ...f, type: t.type }))}
                    aria-pressed={selected}
                    sx={{ p: 1.5, height: '100%' }}
                  >
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Icon icon={t.icon} width={22} />
                      <Typography variant="subtitle2">{t.label}</Typography>
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      {t.description}
                    </Typography>
                  </CardActionArea>
                </Paper>
              );
            })}
          </Box>
        ) : (
          <Chip label={typeLabel(form.type)} sx={{ mb: 2 }} />
        )}

        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mb: 2 }}>
          <Autocomplete
            options={namespaceOptions.length > 0 ? namespaceOptions : ['default']}
            value={form.namespace}
            onChange={(_, v) => setForm(f => ({ ...f, namespace: v ?? 'default' }))}
            renderInput={p => <TextField {...p} label="Namespace" />}
            disabled={!creating}
            disableClearable
            sx={{ minWidth: 240 }}
          />
          <TextField
            label="Name"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            disabled={!creating}
            helperText="Lowercase letters, digits and dashes, e.g. office-only."
            sx={{ flex: 1 }}
          />
        </Stack>

        {credentialsNote && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {credentialsNote}
          </Alert>
        )}

        <TraefikMiddlewareFields form={form} onChange={setForm} creating={creating} />
      </Paper>

      <YamlPreview
        yaml={yamlText}
        caption="Passwords are shown as *** here; the real values are sent on Save."
        placeholder={
          errors.length > 0 ? (
            <Alert severity="info" sx={{ mt: 1 }}>
              {errors.map(e => (
                <div key={e}>{e}</div>
              ))}
            </Alert>
          ) : undefined
        }
      />

      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert severity="success" onClose={() => setSuccess(null)}>
          {success} Switch it on for a route in the Routes tab.
        </Alert>
      )}
      {warning && (
        <Alert severity="warning" onClose={() => setWarning(null)}>
          {warning}
        </Alert>
      )}
      {busy && <LinearProgress />}

      <Divider />

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        justifyContent="flex-end"
        sx={{ pb: 4 }}
      >
        {live && (
          <Button
            variant="text"
            size="large"
            startIcon={<Icon icon="mdi:close" />}
            onClick={() => resetForm()}
            disabled={busy}
          >
            Cancel edit
          </Button>
        )}
        <Button
          variant="contained"
          size="large"
          startIcon={<Icon icon={live ? 'mdi:content-save' : 'mdi:play'} />}
          disabled={errors.length > 0 || busy}
          onClick={save}
        >
          {live ? 'Save changes' : 'Create middleware'}
        </Button>
      </Stack>
    </Stack>
  );
}
