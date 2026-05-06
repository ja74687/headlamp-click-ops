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
  applyConfigMap,
  ConfigMapResource,
  deleteConfigMap,
  getConfigMap,
  isSystemConfigMap,
  listConfigMaps,
} from './lib/kvResources';

type Mode = { kind: 'create' } | { kind: 'edit'; namespace: string; name: string };

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
      setItems(await listConfigMaps());
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
      setItems([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!items) return null;
    const nsSet = new Set(activeNamespaces);
    return items
      .filter(cm => (hideSystem ? !isSystemConfigMap(cm) : true))
      .filter(cm => (nsSet.size > 0 ? nsSet.has(cm.metadata.namespace) : true))
      .filter(cm =>
        filter
          ? cm.metadata.name.toLowerCase().includes(filter.toLowerCase()) ||
            cm.metadata.namespace.toLowerCase().includes(filter.toLowerCase())
          : true,
      )
      .sort((a, b) =>
        `${a.metadata.namespace}/${a.metadata.name}`.localeCompare(
          `${b.metadata.namespace}/${b.metadata.name}`,
        ),
      );
  }, [items, hideSystem, filter, activeNamespaces]);

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
    setMode({ kind: 'edit', namespace: fresh.metadata.namespace, name: fresh.metadata.name });
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
      await applyConfigMap(desired);
      setSuccess(`ConfigMap ${namespace}/${name} saved.`);
      resetForm();
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
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Typography variant="h6">ConfigMaps</Typography>
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
            No ConfigMaps match the filters.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Namespace</TableCell>
                <TableCell>Keys</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map(cm => (
                <TableRow hover key={`${cm.metadata.namespace}/${cm.metadata.name}`}>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                      {cm.metadata.name}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip size="small" label={cm.metadata.namespace} />
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption" color="text.secondary">
                      {Object.keys(cm.data ?? {}).length} keys
                    </Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title="Edit">
                      <IconButton size="small" onClick={() => startEdit(cm)}>
                        <Icon icon="mdi:pencil-outline" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Delete">
                      <IconButton size="small" onClick={() => remove(cm)} color="error">
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
  if (!/^[a-z0-9][-a-z0-9.]*$/.test(cm.metadata.name ?? '')) {
    errs.push('Name must be a valid DNS subdomain (lowercase letters, digits, ".", "-").');
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
