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
  MenuItem,
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
import { ImportOutcome } from './ImportAccountsDialog';
import {
  AnyResource,
  applyResources,
  createResources,
  deleteIfLabelled,
  deleteResource,
  describeResource,
  detectApiServerUrl,
  fetchToken,
  findExisting,
  TokenSecretData,
  waitForToken,
} from './lib/apply';
import { PRESETS, RESOURCE_CATALOG, Verb, VERBS } from './lib/catalog';
import { listManagedAccounts, ManagedAccount } from './lib/discovery';
import { buildKubeconfig, downloadText } from './lib/kubeconfig';
import { planChanges, PlannedChange, staleRoleNamespaces } from './lib/plan';
import { PortableAccount } from './lib/portable';
import {
  accountLabels,
  buildAll,
  buildBindings,
  BuildInput,
  buildRole,
  buildTokenSecret,
  buildUiClusterRead,
  deriveNames,
  roleKind,
  Rule,
  UI_ACCESS_LEVELS,
  UiAccessLevel,
  validateInput,
} from './lib/rbac';
import {
  fetchClusterCaBase64,
  formatExpiry,
  requestToken,
  TOKEN_LIFETIMES,
  wasClamped,
} from './lib/tokenRequest';
import ManagedAccountsList from './ManagedAccountsList';
import OrphansPanel from './OrphansPanel';
import PlanDialog from './PlanDialog';
import YamlPreview from './YamlPreview';

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
  const [uiAccess, setUiAccess] = useState<UiAccessLevel>('namespaces');
  const [tokenMode, setTokenMode] = useState<'longLived' | 'expiring'>('longLived');
  const [tokenLifetime, setTokenLifetime] = useState<number>(30 * 24 * 3600);
  const [tokenNotice, setTokenNotice] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlannedChange[] | null>(null);

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

  const input: BuildInput = useMemo(
    () => ({
      scope,
      namespaces: scope === 'Namespaced' ? selectedNamespaces : [],
      tokenNamespace,
      ...derived,
      uiAccess,
      rules,
    }),
    [scope, selectedNamespaces, tokenNamespace, derived, uiAccess, rules],
  );

  const errors = useMemo(() => validateInput(input), [input]);
  const resources = useMemo(
    () => (errors.length === 0 ? buildAll(input) : []),
    [errors.length, input],
  );
  // Serialising every manifest on each keystroke was the most expensive thing this form did.
  const previewYaml = useMemo(
    () =>
      resources.length > 0
        ? resources.map(r => yaml.dump(r, { noRefs: true, lineWidth: -1 })).join('---\n')
        : '',
    [resources],
  );

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
    setUiAccess('namespaces');
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
    setUiAccess(account.uiAccess);
    setToken(null);
    setApplyError(null);
    setSuccessMessage(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /**
   * Editing is the case where a click can take access away, so it goes through the plan
   * first. Creating cannot delete anything, so it applies straight away.
   */
  function handleApplyClick() {
    if (mode.kind === 'edit') {
      setPlan(planChanges(mode.account, input));
      return;
    }
    handleApply();
  }

  async function handleApply() {
    setPlan(null);
    setApplyError(null);
    setSuccessMessage(null);
    setApplying(true);
    setToken(null);
    try {
      if (mode.kind === 'create') {
        await refuseToOverwrite(resources);
        await createResources(resources);
        const tok = await waitForToken(tokenNamespace, derived.tokenSecretName);
        setToken(tok);
        setSuccessMessage('Account created. Token ready — download the kubeconfig below.');
      } else {
        await reconcileEdit(mode.account, input);
        resetForm();
        setSuccessMessage('Account updated. Download the refreshed kubeconfig from the list above.');
      }
    } catch (err: unknown) {
      setApplyError(err instanceof Error ? err.message : String(err));
    } finally {
      // Also after a failure: the objects may have been written before the token wait timed
      // out, and a list that does not show them invites a retry that cannot succeed.
      setRefreshKey(k => k + 1);
      setApplying(false);
    }
  }

  async function handleDownload() {
    if (!token) return;
    if (!serverUrl && !insecure) {
      setApplyError('Set the API server URL (e.g. https://kube-api.example:6443) before downloading.');
      return;
    }
    setApplyError(null);
    try {
      const creds = await resolveCredentials(
        tokenNamespace,
        derived.serviceAccountName,
        derived.tokenSecretName,
      );
      if (!creds) return;
      const cfg = buildKubeconfig({
        clusterName,
        serverUrl: serverUrl || 'https://kubernetes.default.svc',
        caCrtBase64: creds.caCrtBase64,
        userName: derived.serviceAccountName,
        token: creds.token,
        namespace:
          (scope === 'Namespaced' && selectedNamespaces[0]) ||
          creds.namespace ||
          tokenNamespace ||
          'default',
        insecureSkipTlsVerify: insecure,
      });
      downloadText(`${derived.serviceAccountName}.kubeconfig`, cfg);
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Applied one account at a time: a failure on the third should not hide that the first two
   * landed, so each outcome is reported separately rather than aborting the batch.
   */
  async function handleImport(imported: PortableAccount[]): Promise<ImportOutcome[]> {
    const outcomes: ImportOutcome[] = [];
    let live: ManagedAccount[];
    try {
      live = await listManagedAccounts();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return imported.map(acc => ({ name: acc.name, ok: false, error }));
    }
    for (const acc of imported) {
      try {
        const names = deriveNames(acc.name);
        const manifests = buildAll({
          scope: acc.scope,
          namespaces: acc.scope === 'Namespaced' ? acc.namespaces : [],
          tokenNamespace: acc.namespace,
          ...names,
          uiAccess: acc.uiAccess,
          rules: acc.rules,
        });
        // Overwriting is the point of an import, but only of the same account. Anything else
        // under these names is another account's cluster-scoped role or a foreign object.
        const sameAccount = live.some(
          a => a.name === names.serviceAccountName && a.namespace === acc.namespace,
        );
        if (sameAccount) {
          await applyResources(manifests);
        } else {
          await refuseToOverwrite(manifests);
          await createResources(manifests);
        }
        outcomes.push({ name: acc.name, ok: true });
      } catch (err) {
        outcomes.push({
          name: acc.name,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    setRefreshKey(k => k + 1);
    return outcomes;
  }

  async function handleDownloadForExisting(account: ManagedAccount) {
    if (!serverUrl && !insecure) {
      setPendingUrl('');
      setPendingDownload(account);
      return;
    }
    await downloadForAccount(account, serverUrl);
  }

  /**
   * Either read the long-lived Secret or mint a fresh expiring token. Both paths still need
   * the cluster CA; only the Secret carries one, so TokenRequest has to look it up.
   */
  async function resolveCredentials(
    accountNamespace: string,
    accountName: string,
    tokenSecretName: string,
  ): Promise<{ token: string; caCrtBase64: string; namespace: string } | null> {
    if (tokenMode === 'expiring') {
      const issued = await requestToken(accountNamespace, accountName, tokenLifetime);
      const ca = await fetchClusterCaBase64(accountNamespace);
      if (!ca && !insecure) {
        setApplyError(
          'Could not read the cluster CA (kube-root-ca.crt or kube-public/cluster-info). ' +
            'Tick insecure-skip-tls-verify or use a long-lived token.',
        );
        return null;
      }
      setTokenNotice(
        `Token expires in ${formatExpiry(issued.expirationTimestamp)}` +
          (wasClamped(issued)
            ? ' — the API server capped it below the requested lifetime.'
            : '.'),
      );
      return { token: issued.token, caCrtBase64: ca ?? '', namespace: accountNamespace };
    }
    const tok = await fetchToken(accountNamespace, tokenSecretName);
    if (!tok) {
      setApplyError(`Token secret ${accountNamespace}/${tokenSecretName} has no token yet.`);
      return null;
    }
    setTokenNotice(null);
    return { token: tok.token, caCrtBase64: tok.caCrtBase64, namespace: tok.namespace };
  }

  async function downloadForAccount(account: ManagedAccount, url: string) {
    // resolveCredentials has already said why when it returns null.
    const tok = await resolveCredentials(
      account.namespace,
      account.name,
      account.tokenSecretName,
    );
    if (!tok) return;
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
          onImport={handleImport}
          availableNamespaces={namespaceOptions}
          refreshKey={refreshKey}
        />

        <OrphansPanel refreshKey={refreshKey} />

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
          <Typography variant="h6" gutterBottom>
            Headlamp UI access
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            A RoleBinding only grants access inside its own namespace, even when it points at
            a ClusterRole. Listing namespaces, reading nodes and reading metrics are all
            cluster-scoped, so without a separate ClusterRoleBinding the account gets{' '}
            <code>namespaces is forbidden ... at the cluster scope</code> and an empty cluster
            overview. This creates <code>{derived.clusterReadName}</code> (ClusterRole +
            ClusterRoleBinding) alongside the account.
          </Typography>
          <RadioGroup
            value={uiAccess}
            onChange={e => setUiAccess(e.target.value as UiAccessLevel)}
          >
            {UI_ACCESS_LEVELS.map(l => (
              <FormControlLabel
                key={l.value}
                value={l.value}
                control={<Radio />}
                sx={{ alignItems: 'flex-start', mb: 0.5 }}
                label={
                  <Box sx={{ pt: 0.75 }}>
                    <Typography variant="body2">
                      {l.label}
                      {l.danger && (
                        <Chip
                          label="privilege escalation"
                          size="small"
                          color="warning"
                          sx={{ ml: 1 }}
                        />
                      )}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {l.description}
                    </Typography>
                  </Box>
                }
              />
            ))}
          </RadioGroup>
          {uiAccess === 'kubelet' && (
            <Alert severity="warning" sx={{ mt: 1 }}>
              <AlertTitle>nodes/proxy exposes the kubelet API.</AlertTitle>
              Anyone holding this token can reach kubelet endpoints on every node and read
              logs and metadata of pods in namespaces they were never granted. Pick this only
              if the disk and PVC usage panels are worth that.
            </Alert>
          )}
          {uiAccess === 'none' && scope === 'Namespaced' && (
            <Alert severity="info" sx={{ mt: 1 }}>
              With no cluster-scoped read, this account works with{' '}
              <code>kubectl -n &lt;namespace&gt;</code> but Headlamp will not be able to list
              namespaces. Set the cluster's <em>Allowed namespaces</em> in Headlamp if you want
              to keep it this tight.
            </Alert>
          )}
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

          <Divider sx={{ my: 2 }} />

          <Typography variant="subtitle2" gutterBottom>
            Token
          </Typography>
          <RadioGroup
            row
            value={tokenMode}
            onChange={e => {
              setTokenMode(e.target.value as 'longLived' | 'expiring');
              setTokenNotice(null);
            }}
          >
            <FormControlLabel
              value="longLived"
              control={<Radio />}
              label="Long-lived (Secret)"
            />
            <FormControlLabel
              value="expiring"
              control={<Radio />}
              label="Expiring (TokenRequest)"
            />
          </RadioGroup>
          {tokenMode === 'expiring' ? (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="flex-start">
              <TextField
                select
                size="small"
                label="Valid for"
                value={tokenLifetime}
                onChange={e => setTokenLifetime(Number(e.target.value))}
                sx={{ minWidth: 180 }}
              >
                {TOKEN_LIFETIMES.map(l => (
                  <MenuItem key={l.seconds} value={l.seconds}>
                    {l.label}
                  </MenuItem>
                ))}
              </TextField>
              <Typography variant="caption" color="text.secondary" sx={{ pt: 1, flex: 1 }}>
                A fresh token is minted at download time and the API server enforces the
                expiry. It cannot be renewed from the kubeconfig — when it runs out, come back
                here and download again. The server may grant less than you ask for, and the
                token Secret is still created either way.
              </Typography>
            </Stack>
          ) : (
            <Typography variant="caption" color="text.secondary">
              Never expires and stays valid until the Secret or the ServiceAccount is deleted.
              Convenient, but nothing revokes it if the file leaks.
            </Typography>
          )}
          {tokenNotice && (
            <Alert severity="info" sx={{ mt: 1 }} onClose={() => setTokenNotice(null)}>
              {tokenNotice}
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

        <YamlPreview
          yaml={previewYaml}
          maxHeight={360}
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
            onClick={handleApplyClick}
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

      <PlanDialog
        open={plan !== null}
        accountName={mode.kind === 'edit' ? mode.account.name : derived.serviceAccountName}
        changes={plan ?? []}
        applying={applying}
        onCancel={() => setPlan(null)}
        onConfirm={handleApply}
      />

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

/**
 * Creating must never update. The role, cluster-read and cluster binding names are
 * cluster-scoped, so an account name reused in a second namespace used to overwrite the
 * first account's roles, and a name that matched an existing ServiceAccount took it over.
 */
async function refuseToOverwrite(resources: AnyResource[]): Promise<void> {
  const existing = await findExisting(resources);
  if (existing.length === 0) return;
  throw new Error(
    `Nothing was created: ${existing.map(describeResource).join(', ')} already exist. ` +
      'Role and binding names are shared across the whole cluster, so an account name can be ' +
      'used only once. Edit the existing account or pick another name — and if no account of ' +
      'this name is listed, these are leftovers of a deleted one: remove them under Leftovers.',
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
    (current.bindings.length > 0 || current.clusterBindingName) &&
    current.roleKind !== desiredRoleKind;

  // Apply-first, prune-after: if any step fails, the cluster is left over-permissioned
  // (old bindings still present) rather than under-permissioned (broken account, no access).
  await applyResources([buildTokenSecret(desired), buildRole(desired)]);

  if (roleKindChanged) {
    // roleRef is immutable on (Cluster)RoleBinding, so a kind change forces a delete+recreate
    // of every binding. The new Role/ClusterRole was just created above (different kind, same
    // name, so the two coexist), which keeps the gap window to bindings only.
    for (const b of current.bindings) {
      await deleteResource('rbac.authorization.k8s.io/v1', 'RoleBinding', b.name, b.namespace);
    }
    if (current.clusterBindingName) {
      await deleteResource('rbac.authorization.k8s.io/v1', 'ClusterRoleBinding', current.clusterBindingName);
    }
  }

  await applyResources(desiredBindings);

  // The cluster-scoped read bundle stands on its own: apply it when wanted, remove it when
  // the level drops back to none.
  const uiResources = buildUiClusterRead(desired);
  if (uiResources.length > 0) {
    await applyResources(uiResources);
  } else if (current.uiAccess !== 'none') {
    await deleteUiClusterRead(current.clusterReadName);
  }

  // Prune only once the desired state is in place. Namespace and name travel together in
  // `bindings`; pairing two separately sorted arrays by index used to delete a name that
  // did not exist in that namespace (swallowed as a 404) and leave the real binding live.
  for (const b of current.bindings) {
    if (!desiredKeys.has(`RoleBinding/${b.namespace}/${b.name}`)) {
      await deleteResource('rbac.authorization.k8s.io/v1', 'RoleBinding', b.name, b.namespace);
    }
  }
  if (
    current.clusterBindingName &&
    !desiredKeys.has(`ClusterRoleBinding//${current.clusterBindingName}`)
  ) {
    await deleteResource('rbac.authorization.k8s.io/v1', 'ClusterRoleBinding', current.clusterBindingName);
  }

  if (roleKindChanged) {
    await deleteRole(current);
  } else {
    // A namespaced Role lives next to its single binding. Moving the account to another
    // namespace creates the Role there, so the old one would otherwise stay behind.
    for (const ns of staleRoleNamespaces(current, desired)) {
      await deleteIfLabelled(
        'rbac.authorization.k8s.io/v1',
        'Role',
        current.roleName,
        accountLabels(current.name),
        ns,
      );
    }
  }
}

async function deleteUiClusterRead(name: string): Promise<void> {
  await deleteResource('rbac.authorization.k8s.io/v1', 'ClusterRoleBinding', name);
  await deleteResource('rbac.authorization.k8s.io/v1', 'ClusterRole', name);
}

async function cascadeDelete(account: ManagedAccount): Promise<void> {
  // Delete the bindings actually discovered rather than names rebuilt from the convention,
  // so a renamed or hand-made binding is not left behind still granting access.
  for (const b of account.bindings) {
    await deleteResource('rbac.authorization.k8s.io/v1', 'RoleBinding', b.name, b.namespace);
  }
  if (account.clusterBindingName) {
    await deleteResource('rbac.authorization.k8s.io/v1', 'ClusterRoleBinding', account.clusterBindingName);
  }
  await deleteRole(account);
  await deleteUiClusterRead(account.clusterReadName);
  await deleteResource('v1', 'Secret', account.tokenSecretName, account.namespace);
  await deleteResource('v1', 'ServiceAccount', account.name, account.namespace);
}

/**
 * Only the role this plugin made for the account. `roleName` comes from whichever binding
 * discovery matched first, and a hand-made one may point at a shared role or at `cluster-admin`.
 */
async function deleteRole(account: ManagedAccount): Promise<void> {
  const labels = accountLabels(account.name);
  const rbac = 'rbac.authorization.k8s.io/v1';
  if (account.roleKind === 'ClusterRole') {
    await deleteIfLabelled(rbac, 'ClusterRole', account.roleName, labels);
  } else {
    for (const b of account.bindings) {
      await deleteIfLabelled(rbac, 'Role', account.roleName, labels, b.namespace);
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

