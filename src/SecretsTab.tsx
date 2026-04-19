import { Icon } from '@iconify/react';
import { K8s } from '@kinvolk/headlamp-plugin/lib';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  IconButton,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  Switch,
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
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import KeyValueEditor, { KVEntry } from './KeyValueEditor';
import {
  applySecret,
  decodeBase64ToUtf8,
  deleteSecret,
  encodeUtf8ToBase64,
  getSecret,
  isSystemSecret,
  listSecrets,
  SecretResource,
} from './lib/kvResources';

type Mode = { kind: 'create' } | { kind: 'edit'; namespace: string; name: string };

type SecretTypeDef = {
  type: string;
  label: string;
  description: string;
  requiredKeys?: string[];
};

const SECRET_TYPES: SecretTypeDef[] = [
  { type: 'Opaque', label: 'Opaque (generic)', description: 'Free-form key/value.' },
  {
    type: 'kubernetes.io/tls',
    label: 'TLS certificate',
    description: 'Requires tls.crt and tls.key (PEM-encoded).',
    requiredKeys: ['tls.crt', 'tls.key'],
  },
  {
    type: 'kubernetes.io/basic-auth',
    label: 'Basic auth',
    description: 'Requires username and password.',
    requiredKeys: ['username', 'password'],
  },
  {
    type: 'kubernetes.io/dockerconfigjson',
    label: 'Docker registry',
    description: 'Requires .dockerconfigjson containing a docker auth config.',
    requiredKeys: ['.dockerconfigjson'],
  },
  {
    type: 'kubernetes.io/ssh-auth',
    label: 'SSH auth',
    description: 'Requires ssh-privatekey.',
    requiredKeys: ['ssh-privatekey'],
  },
];

function typeDef(t: string): SecretTypeDef {
  return SECRET_TYPES.find(x => x.type === t) ?? SECRET_TYPES[0];
}

type Props = { activeNamespace?: string };

export default function SecretsTab({ activeNamespace = '' }: Props) {
  const [namespaces] = K8s.ResourceClasses.Namespace.useList();
  const namespaceOptions = (namespaces ?? []).map(n => n.metadata.name).sort();

  const [items, setItems] = useState<SecretResource[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [hideSystem, setHideSystem] = useState(true);
  const [filter, setFilter] = useState('');

  const [mode, setMode] = useState<Mode>({ kind: 'create' });
  const [namespace, setNamespace] = useState<string>(activeNamespace || 'default');
  const [name, setName] = useState('');
  const [secretType, setSecretType] = useState<string>('Opaque');
  const [entries, setEntries] = useState<KVEntry[]>([{ key: '', value: '', alreadyEncoded: false }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (mode.kind === 'create' && activeNamespace) setNamespace(activeNamespace);
  }, [activeNamespace, mode.kind]);

  const load = useCallback(async () => {
    setListError(null);
    try {
      setItems(await listSecrets());
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
      setItems([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const def = typeDef(secretType);
    if (!def.requiredKeys) return;
    setEntries(prev => {
      const existing = new Map(prev.map(e => [e.key, e]));
      return def.requiredKeys!.map(k =>
        existing.get(k) ?? { key: k, value: '', alreadyEncoded: false },
      );
    });
  }, [secretType]);

  const filtered = useMemo(() => {
    if (!items) return null;
    return items
      .filter(s => (hideSystem ? !isSystemSecret(s) : true))
      .filter(s => (activeNamespace ? s.metadata.namespace === activeNamespace : true))
      .filter(s =>
        filter
          ? s.metadata.name.toLowerCase().includes(filter.toLowerCase()) ||
            s.metadata.namespace.toLowerCase().includes(filter.toLowerCase())
          : true,
      )
      .sort((a, b) =>
        `${a.metadata.namespace}/${a.metadata.name}`.localeCompare(
          `${b.metadata.namespace}/${b.metadata.name}`,
        ),
      );
  }, [items, hideSystem, filter, activeNamespace]);

  function resetForm() {
    setMode({ kind: 'create' });
    setNamespace(activeNamespace || 'default');
    setName('');
    setSecretType('Opaque');
    setEntries([{ key: '', value: '', alreadyEncoded: false }]);
    setError(null);
    setSuccess(null);
  }

  async function startEdit(sec: SecretResource) {
    const fresh = (await getSecret(sec.metadata.namespace, sec.metadata.name)) ?? sec;
    setMode({ kind: 'edit', namespace: fresh.metadata.namespace, name: fresh.metadata.name });
    setNamespace(fresh.metadata.namespace);
    setName(fresh.metadata.name);
    setSecretType(fresh.type ?? 'Opaque');
    setEntries(
      Object.entries(fresh.data ?? {}).map(([k, v]) => ({
        key: k,
        value: decodeBase64ToUtf8(v),
        alreadyEncoded: false,
      })),
    );
    setError(null);
    setSuccess(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const desiredData = useMemo(() => {
    const data: Record<string, string> = {};
    for (const e of entries) {
      if (!e.key) continue;
      if (e.alreadyEncoded) data[e.key] = e.value;
      else data[e.key] = encodeUtf8ToBase64(e.value);
    }
    return data;
  }, [entries]);

  const errors = validate(name, namespace, secretType, entries);
  const previewYaml = yaml.dump(
    {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name, namespace },
      type: secretType,
      data: maskForPreview(desiredData),
    },
    { noRefs: true, lineWidth: -1 },
  );

  async function save() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await applySecret({
        metadata: { name, namespace },
        type: secretType,
        data: desiredData,
      });
      setSuccess(`Secret ${namespace}/${name} saved.`);
      resetForm();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(sec: SecretResource) {
    if (!window.confirm(`Delete Secret ${sec.metadata.namespace}/${sec.metadata.name}?`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteSecret(sec.metadata.namespace, sec.metadata.name);
      if (mode.kind === 'edit' && mode.namespace === sec.metadata.namespace && mode.name === sec.metadata.name) {
        resetForm();
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const currentType = typeDef(secretType);

  return (
    <Stack spacing={3}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Typography variant="h6">Secrets</Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            <FormControlLabel
              control={<Switch checked={hideSystem} onChange={e => setHideSystem(e.target.checked)} />}
              label={<Typography variant="body2">Hide system</Typography>}
            />
            <Tooltip title="Refresh">
              <IconButton onClick={load} size="small" aria-label="Refresh">
                <Icon icon="mdi:refresh" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>

        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ mb: 1 }}>
          <TextField
            size="small"
            label="Filter name"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            sx={{ flex: 1 }}
          />
        </Stack>

        {listError && (
          <Alert severity="error" sx={{ mb: 1 }} onClose={() => setListError(null)}>
            {listError}
          </Alert>
        )}
        {filtered === null ? (
          <Stack alignItems="center" sx={{ py: 3 }}>
            <CircularProgress size={24} />
          </Stack>
        ) : filtered.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
            No Secrets match the filters.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Namespace</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Keys</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map(s => (
                <TableRow hover key={`${s.metadata.namespace}/${s.metadata.name}`}>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                      {s.metadata.name}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip size="small" label={s.metadata.namespace} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                      {s.type ?? 'Opaque'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" color="text.secondary">
                      {Object.keys(s.data ?? {}).length} keys
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title="Edit">
                      <IconButton size="small" onClick={() => startEdit(s)}>
                        <Icon icon="mdi:pencil-outline" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete">
                      <IconButton size="small" onClick={() => remove(s)} color="error">
                        <Icon icon="mdi:delete-outline" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="h6">
            {mode.kind === 'edit' ? `Editing ${mode.namespace}/${mode.name}` : 'New Secret'}
          </Typography>
          {mode.kind === 'edit' && (
            <Button size="small" startIcon={<Icon icon="mdi:plus" />} onClick={resetForm}>
              New Secret
            </Button>
          )}
        </Stack>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mb: 2 }}>
          <Autocomplete
            options={namespaceOptions.length > 0 ? namespaceOptions : ['default']}
            value={namespace}
            onChange={(_, v) => setNamespace(v ?? 'default')}
            renderInput={p => <TextField {...p} label="Namespace" />}
            disabled={mode.kind === 'edit'}
            sx={{ minWidth: 240 }}
          />
          <TextField
            label="Name"
            value={name}
            onChange={e => setName(e.target.value)}
            disabled={mode.kind === 'edit'}
            sx={{ flex: 1 }}
          />
          <TextField
            select
            label="Type"
            value={secretType}
            onChange={e => setSecretType(e.target.value)}
            disabled={mode.kind === 'edit'}
            sx={{ minWidth: 240 }}
            helperText={currentType.description}
          >
            {SECRET_TYPES.map(t => (
              <MenuItem key={t.type} value={t.type}>
                {t.label}
              </MenuItem>
            ))}
          </TextField>
        </Stack>

        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          Data
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Values are base64-encoded for you on submit. If you're pasting an already-encoded
          value, tick the checkbox on that row.
        </Typography>
        <KeyValueEditor
          entries={entries}
          onChange={setEntries}
          valueLabel="Value"
          hideValues
          allowFileUpload
          allowBase64Toggle
          lockedKeys={currentType.requiredKeys}
        />
      </Paper>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <Typography variant="h6">YAML preview</Typography>
          <Button
            size="small"
            startIcon={<Icon icon="mdi:content-copy" />}
            onClick={() => navigator.clipboard.writeText(previewYaml).catch(() => {})}
          >
            Copy
          </Button>
        </Stack>
        <Typography variant="caption" color="text.secondary">
          Secret values are shown as <code>***</code> in the preview. The real base64 values are
          sent to the cluster on Save.
        </Typography>
        <Box
          component="pre"
          sx={{
            m: 0,
            mt: 1,
            p: 2,
            backgroundColor: 'action.hover',
            fontFamily: 'monospace',
            fontSize: 13,
            overflow: 'auto',
            maxHeight: 320,
            borderRadius: 1,
          }}
        >
          {previewYaml}
        </Box>
      </Paper>

      {errors.length > 0 && (
        <Alert severity="info">
          {errors.map(e => (
            <div key={e}>{e}</div>
          ))}
        </Alert>
      )}
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert severity="success" onClose={() => setSuccess(null)}>
          {success}
        </Alert>
      )}
      {busy && <LinearProgress />}

      <Divider />

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} justifyContent="flex-end" sx={{ pb: 4 }}>
        {mode.kind === 'edit' && (
          <Button
            variant="text"
            size="large"
            startIcon={<Icon icon="mdi:close" />}
            onClick={resetForm}
            disabled={busy}
          >
            Cancel edit
          </Button>
        )}
        <Button
          variant="contained"
          size="large"
          startIcon={<Icon icon={mode.kind === 'edit' ? 'mdi:content-save' : 'mdi:play'} />}
          disabled={errors.length > 0 || busy}
          onClick={save}
        >
          {mode.kind === 'edit' ? 'Save changes' : 'Create Secret'}
        </Button>
      </Stack>
    </Stack>
  );
}

function validate(
  name: string,
  namespace: string,
  secretType: string,
  entries: KVEntry[],
): string[] {
  const errs: string[] = [];
  if (!namespace) errs.push('Namespace is required.');
  if (!name) errs.push('Name is required.');
  if (name && !/^[a-z0-9][-a-z0-9.]*$/.test(name)) {
    errs.push('Name must be a valid DNS subdomain (lowercase letters, digits, ".", "-").');
  }
  const nonEmpty = entries.filter(e => e.key);
  if (nonEmpty.length === 0) errs.push('At least one data entry is required.');
  for (const e of nonEmpty) {
    if (!/^[-._a-zA-Z0-9]+$/.test(e.key)) {
      errs.push(`Invalid key "${e.key}".`);
    }
    if (!e.value) errs.push(`Key "${e.key}" has empty value.`);
    if (e.alreadyEncoded && e.value) {
      try {
        atob(e.value);
      } catch {
        errs.push(`Key "${e.key}" marked as base64 but value is not valid base64.`);
      }
    }
  }
  const def = typeDef(secretType);
  if (def.requiredKeys) {
    const present = new Set(nonEmpty.map(e => e.key));
    for (const k of def.requiredKeys) {
      if (!present.has(k)) errs.push(`Secret type ${secretType} requires key "${k}".`);
    }
  }
  return errs;
}

function maskForPreview(data: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(data)) out[k] = '***';
  return out;
}
