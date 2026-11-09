import { Icon } from '@iconify/react';
import { K8s } from '@kinvolk/headlamp-plugin/lib';
import {
  Alert,
  Autocomplete,
  Button,
  Divider,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import yaml from 'js-yaml';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import KeyValueEditor, { KVEntry } from './KeyValueEditor';
import KvResourceTable from './KvResourceTable';
import {
  deleteSecret,
  encodeUtf8ToBase64,
  filterKvItems,
  getSecret,
  isDnsSubdomain,
  isSystemSecret,
  listSecrets,
  saveSecret,
  SecretResource,
  tryDecodeBase64ToUtf8,
  withRequiredKeys,
} from './lib/kvResources';
import YamlPreview from './YamlPreview';

type Mode =
  | { kind: 'create' }
  // `live` is the object as it was when editing started; saving checks nobody changed it since.
  | { kind: 'edit'; namespace: string; name: string; live: SecretResource };

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

type Props = { activeNamespaces?: string[] };

export default function SecretsTab({ activeNamespaces = [] }: Props) {
  const [namespaces] = K8s.ResourceClasses.Namespace.useList();
  const namespaceOptions = (namespaces ?? []).map(n => n.metadata.name).sort();
  const defaultNamespace = activeNamespaces[0] ?? 'default';

  const [items, setItems] = useState<SecretResource[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [hideSystem, setHideSystem] = useState(true);
  const [filter, setFilter] = useState('');

  const [mode, setMode] = useState<Mode>({ kind: 'create' });
  const [namespace, setNamespace] = useState<string>(defaultNamespace);
  const [name, setName] = useState('');
  const [secretType, setSecretType] = useState<string>('Opaque');
  const [entries, setEntries] = useState<KVEntry[]>([{ key: '', value: '', alreadyEncoded: false }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (mode.kind === 'edit') {
      if (activeNamespaces.length > 0 && !activeNamespaces.includes(mode.namespace)) {
        setMode({ kind: 'create' });
        setNamespace(activeNamespaces[0]);
        setName('');
        setSecretType('Opaque');
        setEntries([{ key: '', value: '', alreadyEncoded: false }]);
        setError(null);
        setSuccess(null);
      }
      return;
    }
    if (activeNamespaces.length > 0 && !activeNamespaces.includes(namespace)) {
      setNamespace(activeNamespaces[0]);
    }
  }, [activeNamespaces, mode, namespace]);

  const load = useCallback(async () => {
    setListError(null);
    try {
      setItems(await listSecrets(activeNamespaces));
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
      setItems([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNamespaces.join(',')]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Only a type picked by hand reshapes the rows. Doing this in an effect on `secretType`
   * also fired when an existing Secret was loaded for editing, and cut every key outside
   * the required set — a cert-manager TLS Secret lost its `ca.crt` on the next save.
   */
  function changeType(next: string) {
    setSecretType(next);
    const required = typeDef(next).requiredKeys;
    if (!required) return;
    setEntries(prev =>
      withRequiredKeys(prev, required, k => ({ key: k, value: '', alreadyEncoded: false })),
    );
  }

  const filtered = useMemo(
    () =>
      items &&
      filterKvItems(items, {
        hideSystem,
        isSystem: isSystemSecret,
        namespaces: activeNamespaces,
        text: filter,
      }),
    [items, hideSystem, filter, activeNamespaces],
  );

  function resetForm() {
    setMode({ kind: 'create' });
    setNamespace(defaultNamespace);
    setName('');
    setSecretType('Opaque');
    setEntries([{ key: '', value: '', alreadyEncoded: false }]);
    setError(null);
    setSuccess(null);
  }

  async function startEdit(sec: SecretResource) {
    const fresh = (await getSecret(sec.metadata.namespace, sec.metadata.name)) ?? sec;
    setMode({
      kind: 'edit',
      namespace: fresh.metadata.namespace,
      name: fresh.metadata.name,
      live: fresh,
    });
    setNamespace(fresh.metadata.namespace);
    setName(fresh.metadata.name);
    setSecretType(fresh.type ?? 'Opaque');
    setEntries(
      Object.entries(fresh.data ?? {}).map(([k, v]) => {
        // Binary values (keystores, raw keys) survive only as opaque base64 — decoding
        // them to text and re-encoding on save would corrupt them beyond repair.
        const text = tryDecodeBase64ToUtf8(v);
        return text === null
          ? { key: k, value: v, alreadyEncoded: true }
          : { key: k, value: text, alreadyEncoded: false };
      }),
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
      await saveSecret(
        { metadata: { name, namespace }, type: secretType, data: desiredData },
        mode.kind === 'edit' ? mode.live : null,
      );
      // resetForm clears `success`, so the message has to come after it.
      resetForm();
      setSuccess(`Secret ${namespace}/${name} saved.`);
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
      <KvResourceTable
        title="Secrets"
        items={filtered}
        listError={listError}
        onClearError={() => setListError(null)}
        hideSystem={hideSystem}
        onHideSystemChange={setHideSystem}
        filter={filter}
        onFilterChange={setFilter}
        onRefresh={load}
        onEdit={startEdit}
        onDelete={remove}
        typeOf={s => s.type ?? 'Opaque'}
      />

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
            onChange={e => changeType(e.target.value)}
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

      <YamlPreview
        yaml={previewYaml}
        caption={
          <>
            Secret values are shown as <code>***</code> in the preview. The real base64 values
            are sent to the cluster on Save.
          </>
        }
      />

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
  if (name && !isDnsSubdomain(name)) {
    errs.push(
      'Name must be a valid DNS subdomain (lowercase letters, digits, "." and "-", starting and ending with a letter or digit).',
    );
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
