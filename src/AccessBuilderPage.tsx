import { Icon } from '@iconify/react';
import { K8s } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { getCluster } from '@kinvolk/headlamp-plugin/lib/Utils';
import {
  Alert,
  AlertTitle,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  FormGroup,
  FormLabel,
  IconButton,
  LinearProgress,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import yaml from 'js-yaml';
import React, { useEffect, useMemo, useState } from 'react';
import {
  applyResources,
  deleteResource,
  detectApiServerUrl,
  fetchToken,
  TokenSecretData,
  waitForToken,
} from './lib/apply';
import { PRESETS, RESOURCE_CATALOG, Verb, VERBS } from './lib/catalog';
import { ManagedAccount } from './lib/discovery';
import { buildKubeconfig, downloadText } from './lib/kubeconfig';
import {
  bindingName,
  buildAll,
  buildBindings,
  BuildInput,
  buildRole,
  buildTokenSecret,
  deriveNames,
  roleKind,
  Rule,
  validateInput,
} from './lib/rbac';
import ManagedAccountsList from './ManagedAccountsList';

const ALL_API_GROUPS = Array.from(new Set(RESOURCE_CATALOG.map(r => r.group))).sort();

type Scope = 'Namespaced' | 'Cluster';
type Mode = { kind: 'create' } | { kind: 'edit'; account: ManagedAccount };

function emptyRule(): Rule {
  return { apiGroups: [''], resources: [], verbs: ['get', 'list', 'watch'] };
}

export default function AccessBuilderPage() {
  const clusterName = getCluster() ?? 'default';
  const [namespaces] = K8s.ResourceClasses.Namespace.useList();
  const namespaceOptions = (namespaces ?? []).map(n => n.metadata.name).sort();

  const [mode, setMode] = useState<Mode>({ kind: 'create' });
  const [scope, setScope] = useState<Scope>('Namespaced');
  const [selectedNamespaces, setSelectedNamespaces] = useState<string[]>(['default']);
  const [tokenNamespace, setTokenNamespace] = useState<string>('default');
  const [saName, setSaName] = useState<string>('dev-user');
  const [rules, setRules] = useState<Rule[]>([emptyRule()]);
  const [serverUrl, setServerUrl] = useState<string>('');
  const [insecure, setInsecure] = useState<boolean>(false);

  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [token, setToken] = useState<TokenSecretData | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [pendingDownload, setPendingDownload] = useState<ManagedAccount | null>(null);
  const [pendingUrl, setPendingUrl] = useState<string>('');
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);

  const derived = useMemo(() => deriveNames(saName), [saName]);

  const input: BuildInput = {
    scope,
    namespaces: scope === 'Namespaced' ? selectedNamespaces : [],
    tokenNamespace,
    ...derived,
    rules,
  };

  const errors = validateInput(input);
  const resources = errors.length === 0 ? buildAll(input) : [];
  const previewYaml =
    resources.length > 0
      ? resources.map(r => yaml.dump(r, { noRefs: true, lineWidth: -1 })).join('---\n')
      : '';

  useEffect(() => {
    if (scope === 'Cluster' && !tokenNamespace) setTokenNamespace('default');
  }, [scope, tokenNamespace]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const url = await detectApiServerUrl();
      if (!cancelled && url) setServerUrl(prev => prev || url);
    })();
    return () => {
      cancelled = true;
    };
    // only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runDetect(setTarget: (url: string) => void) {
    setDetecting(true);
    setDetectError(null);
    try {
      const url = await detectApiServerUrl();
      if (url) setTarget(url);
      else setDetectError('Could not detect API server URL (no kube-public/cluster-info and no readable kubernetes Endpoints).');
    } catch (err) {
      setDetectError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetecting(false);
    }
  }

  function resetForm() {
    setMode({ kind: 'create' });
    setScope('Namespaced');
    setSelectedNamespaces(['default']);
    setTokenNamespace('default');
    setSaName('dev-user');
    setRules([emptyRule()]);
    setServerUrl('');
    setInsecure(false);
    setToken(null);
    setApplyError(null);
    setSuccessMessage(null);
  }

  function loadAccountIntoForm(account: ManagedAccount) {
    setMode({ kind: 'edit', account });
    setScope(account.scope);
    setSelectedNamespaces(
      account.scope === 'Cluster' ? [] : account.bindingNamespaces,
    );
    setTokenNamespace(account.namespace);
    setSaName(account.name);
    setRules(account.rules.length > 0 ? account.rules : [emptyRule()]);
    setToken(null);
    setApplyError(null);
    setSuccessMessage(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleApply() {
    setApplyError(null);
    setSuccessMessage(null);
    setApplying(true);
    setToken(null);
    try {
      if (mode.kind === 'create') {
        await applyResources(resources);
        const tok = await waitForToken(tokenNamespace, derived.tokenSecretName);
        setToken(tok);
        setSuccessMessage('Account created. Token ready — download the kubeconfig below.');
      } else {
        await reconcileEdit(mode.account, input);
        resetForm();
        setSuccessMessage('Account updated. Download the refreshed kubeconfig from the list above.');
      }
      setRefreshKey(k => k + 1);
    } catch (err: unknown) {
      setApplyError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }

  function handleDownload() {
    if (!token) return;
    if (!serverUrl && !insecure) {
      setApplyError('Set the API server URL (e.g. https://kube-api.example:6443) before downloading.');
      return;
    }
    const cfg = buildKubeconfig({
      clusterName,
      serverUrl: serverUrl || 'https://kubernetes.default.svc',
      caCrtBase64: token.caCrtBase64,
      userName: derived.serviceAccountName,
      token: token.token,
      namespace:
        (scope === 'Namespaced' && selectedNamespaces[0]) ||
        token.namespace ||
        tokenNamespace ||
        'default',
      insecureSkipTlsVerify: insecure,
    });
    downloadText(`${derived.serviceAccountName}.kubeconfig`, cfg);
  }

  function handleCopyYaml() {
    navigator.clipboard.writeText(previewYaml).catch(() => {});
  }

  async function handleDownloadForExisting(account: ManagedAccount) {
    if (!serverUrl && !insecure) {
      setPendingUrl('');
      setPendingDownload(account);
      return;
    }
    await downloadForAccount(account, serverUrl);
  }

  async function downloadForAccount(account: ManagedAccount, url: string) {
    const tok = await fetchToken(account.namespace, account.tokenSecretName);
    if (!tok) {
      setApplyError(
        `Token secret ${account.namespace}/${account.tokenSecretName} has no token yet.`,
      );
      return;
    }
    const cfg = buildKubeconfig({
      clusterName,
      serverUrl: url || 'https://kubernetes.default.svc',
      caCrtBase64: tok.caCrtBase64,
      userName: account.name,
      token: tok.token,
      namespace:
        (account.scope === 'Namespaced' && account.bindingNamespaces[0]) ||
        tok.namespace ||
        account.namespace,
      insecureSkipTlsVerify: insecure,
    });
    downloadText(`${account.name}.kubeconfig`, cfg);
  }

  async function confirmPendingDownload() {
    if (!pendingDownload) return;
    if (!pendingUrl && !insecure) return;
    const account = pendingDownload;
    setPendingDownload(null);
    if (!serverUrl) setServerUrl(pendingUrl);
    await downloadForAccount(account, pendingUrl);
  }

  return (
    <SectionBox title="Access Builder" textAlign="left">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Create (and manage) a ServiceAccount, an RBAC Role or ClusterRole, the binding(s), a
        long-lived token Secret, and export a ready-to-use kubeconfig that works in{' '}
        <code>kubectl</code> and Headlamp alike.
      </Typography>

      <Stack spacing={3}>
        <ManagedAccountsList
          onEdit={loadAccountIntoForm}
          onDelete={async a => {
            await cascadeDelete(a);
            if (mode.kind === 'edit' && mode.account.name === a.name) resetForm();
          }}
          onDownload={handleDownloadForExisting}
          refreshKey={refreshKey}
        />

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography variant="h6">
              {mode.kind === 'edit' ? `Editing "${mode.account.name}"` : 'New account'}
            </Typography>
            {mode.kind === 'edit' && (
              <Button size="small" onClick={resetForm} startIcon={<Icon icon="mdi:plus" />}>
                New account
              </Button>
            )}
          </Stack>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mt: 1 }}>
            <TextField
              label="ServiceAccount name"
              value={saName}
              onChange={e => setSaName(e.target.value)}
              helperText={`Will be sanitised to: ${derived.serviceAccountName}`}
              disabled={mode.kind === 'edit'}
              sx={{ flex: 1 }}
            />
            <TextField
              label="Role / Binding / Secret names"
              value={`${derived.roleName} / ${derived.bindingNamePrefix}[-<ns>] / ${derived.tokenSecretName}`}
              disabled
              sx={{ flex: 2 }}
            />
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h6" gutterBottom>
            Scope
          </Typography>
          <RadioGroup row value={scope} onChange={e => setScope(e.target.value as Scope)}>
            <FormControlLabel value="Namespaced" control={<Radio />} label="Namespaced" />
            <FormControlLabel
              value="Cluster"
              control={<Radio />}
              label="Cluster-wide (ClusterRole)"
            />
          </RadioGroup>

          {scope === 'Cluster' && (
            <Alert severity="warning" sx={{ my: 1 }}>
              <AlertTitle>Cluster-wide scope grants access across every namespace.</AlertTitle>
              Only use this for audit/admin accounts. The token Secret itself still lives in a
              namespace — pick one below.
            </Alert>
          )}

          {scope === 'Namespaced' && (
            <Autocomplete
              multiple
              options={namespaceOptions.length > 0 ? namespaceOptions : ['default']}
              value={selectedNamespaces}
              onChange={(_, v) => {
                setSelectedNamespaces(v);
                if (
                  mode.kind === 'create' &&
                  v.length > 0 &&
                  !v.includes(tokenNamespace)
                ) {
                  setTokenNamespace(v[0]);
                }
              }}
              renderInput={params => (
                <TextField
                  {...params}
                  label="Namespaces"
                  helperText={
                    selectedNamespaces.length <= 1
                      ? 'Role + RoleBinding will be created in this namespace.'
                      : `ClusterRole + ${selectedNamespaces.length} RoleBindings (one per namespace) will be created.`
                  }
                  sx={{ mt: 1 }}
                />
              )}
            />
          )}

          <Autocomplete
            options={namespaceOptions.length > 0 ? namespaceOptions : ['default']}
            value={tokenNamespace}
            onChange={(_, v) => setTokenNamespace(v ?? 'default')}
            renderInput={params => (
              <TextField
                {...params}
                label="Namespace for the ServiceAccount + token Secret"
                sx={{ mt: 2, maxWidth: 420 }}
                helperText="This is where the SA and its token Secret live. Changing it requires a re-create."
              />
            )}
            disabled={mode.kind === 'edit'}
          />
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography variant="h6">Permissions</Typography>
            <Button
              startIcon={<Icon icon="mdi:plus" />}
              size="small"
              onClick={() => setRules(r => [...r, emptyRule()])}
            >
              Add rule
            </Button>
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Start from a preset or build rules manually. Use <code>*</code> to mean "all".
          </Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mb: 2 }} useFlexGap>
            {PRESETS.map(p => (
              <Tooltip key={p.id} title={p.description}>
                <Chip
                  label={p.label}
                  onClick={() => {
                    setScope(p.scope);
                    setRules(p.rules.map(r => ({ ...r, verbs: [...r.verbs] })));
                  }}
                  color={p.id === 'cluster-admin' ? 'warning' : 'default'}
                />
              </Tooltip>
            ))}
          </Stack>

          <Stack spacing={2}>
            {rules.map((rule, idx) => (
              <RuleEditor
                key={idx}
                rule={rule}
                scope={scope}
                onChange={next => setRules(rs => rs.map((r, i) => (i === idx ? next : r)))}
                onRemove={
                  rules.length > 1 ? () => setRules(rs => rs.filter((_, i) => i !== idx)) : undefined
                }
                index={idx}
              />
            ))}
          </Stack>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h6" gutterBottom>
            Kubeconfig
          </Typography>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="flex-start">
            <TextField
              label="API server URL"
              placeholder="https://kube-api.example:6443"
              value={serverUrl}
              onChange={e => setServerUrl(e.target.value)}
              helperText="Auto-detected from kube-public/cluster-info or the kubernetes Endpoints. Override if needed."
              sx={{ flex: 1 }}
            />
            <Button
              variant="outlined"
              size="small"
              startIcon={<Icon icon="mdi:magnify" />}
              onClick={() => runDetect(setServerUrl)}
              disabled={detecting}
              sx={{ mt: 1 }}
            >
              {detecting ? 'Detecting…' : 'Detect'}
            </Button>
            <FormControlLabel
              control={<Checkbox checked={insecure} onChange={e => setInsecure(e.target.checked)} />}
              label="insecure-skip-tls-verify"
              sx={{ mt: 1 }}
            />
          </Stack>
          {detectError && (
            <Alert severity="warning" sx={{ mt: 1 }} onClose={() => setDetectError(null)}>
              {detectError}
            </Alert>
          )}
          <Alert severity="info" icon={<Icon icon="mdi:lightbulb-on-outline" />} sx={{ mt: 2 }}>
            <AlertTitle>Import into Headlamp</AlertTitle>
            Once downloaded, the <code>.kubeconfig</code> file works in two ways:
            <ul style={{ margin: '4px 0 0 16px' }}>
              <li>
                <b>Headlamp desktop</b>: Home → <i>Add cluster</i> → <i>Load from KubeConfig</i>{' '}
                and pick the file.
              </li>
              <li>
                <b>kubectl</b>: <code>kubectl --kubeconfig=./{'{name}'}.kubeconfig get pods</code>, or
                merge into your main <code>~/.kube/config</code>.
              </li>
            </ul>
          </Alert>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography variant="h6">YAML preview</Typography>
            <Button
              size="small"
              startIcon={<Icon icon="mdi:content-copy" />}
              onClick={handleCopyYaml}
              disabled={!previewYaml}
            >
              Copy
            </Button>
          </Stack>
          {errors.length > 0 ? (
            <Alert severity="info" sx={{ mt: 1 }}>
              {errors.map(e => (
                <div key={e}>{e}</div>
              ))}
            </Alert>
          ) : (
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
                maxHeight: 360,
                borderRadius: 1,
              }}
            >
              {previewYaml}
            </Box>
          )}
        </Paper>

        {applyError && (
          <Alert severity="error" onClose={() => setApplyError(null)}>
            {applyError}
          </Alert>
        )}
        {successMessage && (
          <Alert severity="success" onClose={() => setSuccessMessage(null)}>
            {successMessage}
          </Alert>
        )}
        {applying && <LinearProgress />}

        <Divider />

        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={2}
          justifyContent="flex-end"
          flexWrap="wrap"
          useFlexGap
          sx={{ pb: 4 }}
        >
          {mode.kind === 'edit' && (
            <Button
              variant="text"
              size="large"
              startIcon={<Icon icon="mdi:close" />}
              onClick={resetForm}
              disabled={applying}
            >
              Cancel edit
            </Button>
          )}
          <Button
            variant="contained"
            size="large"
            startIcon={<Icon icon={mode.kind === 'edit' ? 'mdi:content-save' : 'mdi:play'} />}
            disabled={errors.length > 0 || applying}
            onClick={handleApply}
          >
            {mode.kind === 'edit' ? 'Save changes' : 'Apply to cluster'}
          </Button>
          <Button
            variant="outlined"
            size="large"
            startIcon={<Icon icon="mdi:download" />}
            disabled={!token || applying}
            onClick={handleDownload}
          >
            Download kubeconfig
          </Button>
        </Stack>
      </Stack>

      <Dialog
        open={pendingDownload !== null}
        onClose={() => setPendingDownload(null)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>API server URL</DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ mb: 2 }}>
            Where should <code>kubectl</code>/Headlamp connect for account{' '}
            <b>{pendingDownload?.name}</b>? Headlamp proxies the API, so the real server URL
            isn't auto-detectable — paste it here. You can also save it for this session by
            typing it into the <i>API server URL</i> field above.
          </DialogContentText>
          <Stack direction="row" spacing={1} alignItems="flex-start">
            <TextField
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              fullWidth
              placeholder="https://kube-api.example:6443"
              value={pendingUrl}
              onChange={e => setPendingUrl(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') confirmPendingDownload();
              }}
              label="API server URL"
            />
            <Button
              variant="outlined"
              startIcon={<Icon icon="mdi:magnify" />}
              onClick={() => runDetect(setPendingUrl)}
              disabled={detecting}
              sx={{ mt: 1 }}
            >
              Detect
            </Button>
          </Stack>
          <FormControlLabel
            control={<Checkbox checked={insecure} onChange={e => setInsecure(e.target.checked)} />}
            label="insecure-skip-tls-verify"
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDownload(null)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={!pendingUrl && !insecure}
            onClick={confirmPendingDownload}
          >
            Download
          </Button>
        </DialogActions>
      </Dialog>
    </SectionBox>
  );
}

async function reconcileEdit(current: ManagedAccount, desired: BuildInput): Promise<void> {
  const desiredBindings = buildBindings(desired);
  const desiredKeys = new Set(
    desiredBindings.map(
      b => `${b.kind}/${(b as any).metadata.namespace ?? ''}/${(b as any).metadata.name}`,
    ),
  );

  const desiredRoleKind = roleKind(desired);
  const roleKindChanged =
    (current.bindingNamespaces.length > 0 || current.clusterBindingName) &&
    current.roleKind !== desiredRoleKind;

  // Apply-first, prune-after: if any step fails, the cluster is left over-permissioned
  // (old bindings still present) rather than under-permissioned (broken account, no access).
  await applyResources([buildTokenSecret(desired), buildRole(desired)]);

  if (roleKindChanged) {
    // roleRef is immutable on (Cluster)RoleBinding, so a kind change forces a delete+recreate
    // of every binding. The new Role/ClusterRole was just created above (different kind, same
    // name → coexists with the old one), so the gap window is just bindings, not the role.
    for (const [i, ns] of current.bindingNamespaces.entries()) {
      const name = current.bindingNames[i] ?? bindingName(`${current.name}-binding`, ns);
      await deleteResource('rbac.authorization.k8s.io/v1', 'RoleBinding', name, ns);
    }
    if (current.clusterBindingName) {
      await deleteResource(
        'rbac.authorization.k8s.io/v1',
        'ClusterRoleBinding',
        current.clusterBindingName,
      );
    }
  }

  await applyResources(desiredBindings);

  // Only prune after the desired state is in place.
  // (When roleKindChanged, the kindChanged block above already removed every old binding;
  // anything still desired was just recreated in Phase 3, so this loop is a no-op for it.)
  for (const [i, ns] of current.bindingNamespaces.entries()) {
    const name = current.bindingNames[i] ?? bindingName(`${current.name}-binding`, ns);
    const key = `RoleBinding/${ns}/${name}`;
    if (!desiredKeys.has(key)) {
      await deleteResource('rbac.authorization.k8s.io/v1', 'RoleBinding', name, ns);
    }
  }
  if (current.clusterBindingName) {
    const key = `ClusterRoleBinding//${current.clusterBindingName}`;
    if (!desiredKeys.has(key)) {
      await deleteResource(
        'rbac.authorization.k8s.io/v1',
        'ClusterRoleBinding',
        current.clusterBindingName,
      );
    }
  }

  if (roleKindChanged) {
    await deleteRole(current);
  }
}

async function cascadeDelete(account: ManagedAccount): Promise<void> {
  for (const ns of account.bindingNamespaces) {
    await deleteResource(
      'rbac.authorization.k8s.io/v1',
      'RoleBinding',
      bindingName(`${account.name}-binding`, ns),
      ns,
    );
  }
  if (account.clusterBindingName) {
    await deleteResource(
      'rbac.authorization.k8s.io/v1',
      'ClusterRoleBinding',
      account.clusterBindingName,
    );
  }
  if (account.roleKind === 'ClusterRole') {
    await deleteResource('rbac.authorization.k8s.io/v1', 'ClusterRole', account.roleName);
  } else {
    for (const ns of account.bindingNamespaces) {
      await deleteResource('rbac.authorization.k8s.io/v1', 'Role', account.roleName, ns);
    }
  }
  await deleteResource('v1', 'Secret', account.tokenSecretName, account.namespace);
  await deleteResource('v1', 'ServiceAccount', account.name, account.namespace);
}

async function deleteRole(account: ManagedAccount): Promise<void> {
  if (account.roleKind === 'ClusterRole') {
    await deleteResource('rbac.authorization.k8s.io/v1', 'ClusterRole', account.roleName);
  } else {
    for (const ns of account.bindingNamespaces) {
      await deleteResource('rbac.authorization.k8s.io/v1', 'Role', account.roleName, ns);
    }
  }
}

function RuleEditor({
  rule,
  scope,
  onChange,
  onRemove,
  index,
}: {
  rule: Rule;
  scope: Scope;
  onChange: (r: Rule) => void;
  onRemove?: () => void;
  index: number;
}) {
  const resourcesForScope = RESOURCE_CATALOG.filter(
    r => scope === 'Cluster' || r.scope === 'Namespaced',
  );
  const resourceOptions = ['*', ...Array.from(new Set(resourcesForScope.map(r => r.resource)))];
  const apiGroupOptions = ['*', ...ALL_API_GROUPS.map(g => (g === '' ? '(core)' : g))];

  return (
    <Paper variant="outlined" sx={{ p: 2, backgroundColor: 'background.default' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="subtitle2">Rule {index + 1}</Typography>
        {onRemove && (
          <IconButton size="small" onClick={onRemove} aria-label="Remove rule">
            <Icon icon="mdi:delete-outline" />
          </IconButton>
        )}
      </Stack>

      <Stack spacing={2}>
        <Autocomplete
          multiple
          freeSolo
          options={apiGroupOptions}
          value={rule.apiGroups.map(g => (g === '' ? '(core)' : g))}
          onChange={(_, v) =>
            onChange({
              ...rule,
              apiGroups: (v as string[]).map(g => (g === '(core)' ? '' : g)),
            })
          }
          renderInput={params => (
            <TextField {...params} label="API groups" placeholder="e.g. apps, batch, *" />
          )}
        />
        <Autocomplete
          multiple
          freeSolo
          options={resourceOptions}
          value={rule.resources}
          onChange={(_, v) => onChange({ ...rule, resources: v as string[] })}
          renderInput={params => (
            <TextField {...params} label="Resources" placeholder="e.g. pods, deployments, *" />
          )}
        />
        <FormControl>
          <FormLabel>Verbs</FormLabel>
          <FormGroup row>
            {VERBS.map(v => (
              <FormControlLabel
                key={v}
                control={
                  <Checkbox
                    size="small"
                    checked={rule.verbs.includes(v)}
                    onChange={e => {
                      const next = new Set(rule.verbs);
                      if (e.target.checked) next.add(v);
                      else next.delete(v);
                      onChange({ ...rule, verbs: Array.from(next) as Verb[] });
                    }}
                  />
                }
                label={v}
              />
            ))}
          </FormGroup>
        </FormControl>
      </Stack>
    </Paper>
  );
}

