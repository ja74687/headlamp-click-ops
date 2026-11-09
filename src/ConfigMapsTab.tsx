import { Icon } from '@iconify/react';
import { K8s } from '@kinvolk/headlamp-plugin/lib';
import {
  Alert,
  Autocomplete,
  Button,
  Divider,
  LinearProgress,
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
  ConfigMapResource,
  deleteConfigMap,
  filterKvItems,
  getConfigMap,
  isDnsSubdomain,
  isSystemConfigMap,
  listConfigMaps,
  saveConfigMap,
} from './lib/kvResources';
import YamlPreview from './YamlPreview';

type Mode =
  | { kind: 'create' }
  // `live` is the object as it was when editing started; saving checks nobody changed it since.
  | { kind: 'edit'; namespace: string; name: string; live: ConfigMapResource };

type Props = { activeNamespaces?: string[] };

export default function ConfigMapsTab({ activeNamespaces = [] }: Props) {
  const [namespaces] = K8s.ResourceClasses.Namespace.useList();
  const namespaceOptions = (namespaces ?? []).map(n => n.metadata.name).sort();
  const defaultNamespace = activeNamespaces[0] ?? 'default';

  const [items, setItems] = useState<ConfigMapResource[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [hideSystem, setHideSystem] = useState(true);
  const [filter, setFilter] = useState('');

  const [mode, setMode] = useState<Mode>({ kind: 'create' });
  const [namespace, setNamespace] = useState<string>(defaultNamespace);
  const [name, setName] = useState('');
  const [entries, setEntries] = useState<KVEntry[]>([{ key: '', value: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (mode.kind === 'edit') {
      if (activeNamespaces.length > 0 && !activeNamespaces.includes(mode.namespace)) {
        setMode({ kind: 'create' });
        setNamespace(activeNamespaces[0]);
        setName('');
        setEntries([{ key: '', value: '' }]);
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
      setItems(await listConfigMaps(activeNamespaces));
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
      setItems([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNamespaces.join(',')]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(
    () =>
      items &&
      filterKvItems(items, {
        hideSystem,
        isSystem: isSystemConfigMap,
        namespaces: activeNamespaces,
        text: filter,
      }),
    [items, hideSystem, filter, activeNamespaces],
  );

  function resetForm() {
    setMode({ kind: 'create' });
    setNamespace(defaultNamespace);
    setName('');
    setEntries([{ key: '', value: '' }]);
    setError(null);
    setSuccess(null);
  }

  async function startEdit(cm: ConfigMapResource) {
    const fresh = (await getConfigMap(cm.metadata.namespace, cm.metadata.name)) ?? cm;
    setMode({
      kind: 'edit',
      namespace: fresh.metadata.namespace,
      name: fresh.metadata.name,
      live: fresh,
    });
    setNamespace(fresh.metadata.namespace);
    setName(fresh.metadata.name);
    setEntries(
      Object.entries(fresh.data ?? {}).map(([k, v]) => ({ key: k, value: v })),
    );
    setError(null);
    setSuccess(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const desired = useMemo(() => {
    const data: Record<string, string> = {};
    for (const e of entries) {
      if (!e.key) continue;
      data[e.key] = e.value;
    }
    return {
      metadata: { name, namespace },
      data,
    } as ConfigMapResource;
  }, [namespace, name, entries]);

  const errors = validate(desired);
  const previewYaml = yaml.dump(
    { apiVersion: 'v1', kind: 'ConfigMap', ...desired },
    { noRefs: true, lineWidth: -1 },
  );

  async function save() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await saveConfigMap(desired, mode.kind === 'edit' ? mode.live : null);
      // resetForm clears `success`, so the message has to come after it.
      resetForm();
      setSuccess(`ConfigMap ${namespace}/${name} saved.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(cm: ConfigMapResource) {
    if (
      !window.confirm(`Delete ConfigMap ${cm.metadata.namespace}/${cm.metadata.name}?`)
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteConfigMap(cm.metadata.namespace, cm.metadata.name);
      if (mode.kind === 'edit' && mode.namespace === cm.metadata.namespace && mode.name === cm.metadata.name) {
        resetForm();
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack spacing={3}>
      <KvResourceTable
        title="ConfigMaps"
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
      />

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="h6">
            {mode.kind === 'edit' ? `Editing ${mode.namespace}/${mode.name}` : 'New ConfigMap'}
          </Typography>
          {mode.kind === 'edit' && (
            <Button size="small" startIcon={<Icon icon="mdi:plus" />} onClick={resetForm}>
              New ConfigMap
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
        </Stack>

        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          Data
        </Typography>
        <KeyValueEditor
          entries={entries}
          onChange={setEntries}
          valueLabel="Value"
          allowFileUpload={false}
          allowBase64Toggle={false}
        />
      </Paper>

      <YamlPreview yaml={previewYaml} />

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
          {mode.kind === 'edit' ? 'Save changes' : 'Create ConfigMap'}
        </Button>
      </Stack>
    </Stack>
  );
}

function validate(cm: ConfigMapResource): string[] {
  const errs: string[] = [];
  if (!cm.metadata.namespace) errs.push('Namespace is required.');
  if (!cm.metadata.name) errs.push('Name is required.');
  if (cm.metadata.name && !isDnsSubdomain(cm.metadata.name)) {
    errs.push(
      'Name must be a valid DNS subdomain (lowercase letters, digits, "." and "-", starting and ending with a letter or digit).',
    );
  }
  const keys = Object.keys(cm.data ?? {});
  if (keys.length === 0) errs.push('At least one data entry is required.');
  for (const k of keys) {
    if (!/^[-._a-zA-Z0-9]+$/.test(k)) {
      errs.push(`Invalid key "${k}" — allowed: letters, digits, "-", "_", ".".`);
    }
  }
  return errs;
}
