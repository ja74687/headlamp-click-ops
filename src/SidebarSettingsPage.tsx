import { Icon } from '@iconify/react';
import { registerSidebarEntryFilter } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  DiscoveredEntry,
  getDiscoveredEntries,
  loadSettings,
  saveSettings,
  subscribeDiscovered,
} from './lib/sidebarSettings';

function useDiscovered() {
  return useSyncExternalStore(subscribeDiscovered, getDiscoveredEntries, getDiscoveredEntries);
}

const OWN_ENTRIES = new Set([
  'access-builder',
  'resource-builder',
  'cluster-monitor',
]);

interface Category {
  parent: DiscoveredEntry;
  children: DiscoveredEntry[];
}

interface OrphanRow {
  entry: DiscoveredEntry;
  missingParentName: string;
}

function normUrl(u?: string): string | null {
  if (!u) return null;
  const stripped = u.replace(/\/+$/, '');
  return stripped.length > 0 ? stripped : '/';
}

function findUrlBasedParent(
  entry: DiscoveredEntry,
  candidates: DiscoveredEntry[],
): string | null {
  const myUrl = normUrl(entry.url);
  if (!myUrl || myUrl === '/') return null;
  let best: { name: string; len: number } | null = null;
  for (const c of candidates) {
    if (c.name === entry.name) continue;
    const cUrl = normUrl(c.url);
    if (!cUrl || cUrl === '/') continue;
    if (cUrl === myUrl) continue;
    if (myUrl.startsWith(cUrl + '/')) {
      if (!best || cUrl.length > best.len) {
        best = { name: c.name, len: cUrl.length };
      }
    }
  }
  return best?.name ?? null;
}

const CRD_GROUP_PREFIX = 'group-';
const CRD_ROOT_NAMES = new Set(['crds', 'customresources', 'custom-resources']);

const KNOWN_HIERARCHY: Record<string, string> = {
  Pods: 'workloads',
  Deployments: 'workloads',
  ReplicaSets: 'workloads',
  StatefulSets: 'workloads',
  DaemonSets: 'workloads',
  Jobs: 'workloads',
  CronJobs: 'workloads',
  podDisruptionBudgets: 'workloads',
  horizontalPodAutoscalers: 'workloads',
  verticalPodAutoscalers: 'workloads',
  persistentVolumes: 'storage',
  persistentVolumeClaims: 'storage',
  storageClasses: 'storage',
  volumeAttachments: 'storage',
  services: 'network',
  ingresses: 'network',
  ingressclasses: 'network',
  NetworkPolicies: 'network',
  networkPolicies: 'network',
  endpoints: 'network',
  endpointslices: 'network',
  endpointSlices: 'network',
  portforwards: 'network',
  serviceAccounts: 'security',
  roles: 'security',
  roleBindings: 'security',
  clusterRoles: 'security',
  clusterRoleBindings: 'security',
  configMaps: 'config',
  secrets: 'config',
  limitRanges: 'config',
  resourceQuotas: 'config',
  priorityClasses: 'config',
  runtimeClasses: 'config',
  leases: 'config',
  mutatingWebhookConfigurations: 'config',
  validatingWebhookConfigurations: 'config',
  validatingAdminissionPolicy: 'config',
  validatingAdmissionPolicies: 'config',
  validatingAdmissionPolicyBindings: 'config',
  nodes: 'cluster',
  namespaces: 'cluster',
  events: 'cluster',
  gatewayclasses: 'gatewayapi',
  gateways: 'gatewayapi',
  httproutes: 'gatewayapi',
  grpcroutes: 'gatewayapi',
  tcproutes: 'gatewayapi',
  tlsroutes: 'gatewayapi',
  udproutes: 'gatewayapi',
  referencegrants: 'gatewayapi',
  backendtlspolicies: 'gatewayapi',
  backendtrafficpolicies: 'gatewayapi',
};

function findKnownParent(entry: DiscoveredEntry, byName: Map<string, DiscoveredEntry>): string | null {
  const target = KNOWN_HIERARCHY[entry.name];
  if (target && byName.has(target)) return target;
  return null;
}

function findNamePatternParent(
  entry: DiscoveredEntry,
  byName: Map<string, DiscoveredEntry>,
): string | null {
  const name = entry.name;

  if (name.startsWith(CRD_GROUP_PREFIX)) {
    for (const candidate of CRD_ROOT_NAMES) {
      if (byName.has(candidate)) return candidate;
    }
    return null;
  }

  const dotIdx = name.indexOf('.');
  if (dotIdx > 0) {
    const groupSuffix = name.slice(dotIdx + 1);
    const candidateGroupName = `${CRD_GROUP_PREFIX}${groupSuffix}`;
    if (byName.has(candidateGroupName)) return candidateGroupName;
    let cursor = groupSuffix;
    while (cursor.includes('.')) {
      cursor = cursor.slice(cursor.indexOf('.') + 1);
      if (byName.has(`${CRD_GROUP_PREFIX}${cursor}`)) return `${CRD_GROUP_PREFIX}${cursor}`;
    }
  }
  return null;
}

function buildLayout(entries: DiscoveredEntry[]): {
  standalones: DiscoveredEntry[];
  categories: Category[];
  orphans: OrphanRow[];
} {
  const byName = new Map<string, DiscoveredEntry>();
  entries.forEach(e => byName.set(e.name, e));

  const childrenByParent = new Map<string, DiscoveredEntry[]>();
  const topLevel: DiscoveredEntry[] = [];
  const orphans: OrphanRow[] = [];

  entries.forEach(e => {
    if (e.parent !== null) {
      if (byName.has(e.parent)) {
        const arr = childrenByParent.get(e.parent) ?? [];
        arr.push(e);
        childrenByParent.set(e.parent, arr);
      } else {
        orphans.push({ entry: e, missingParentName: e.parent });
      }
      return;
    }
    const inferred =
      findKnownParent(e, byName) ??
      findUrlBasedParent(e, entries) ??
      findNamePatternParent(e, byName);
    if (inferred && byName.has(inferred)) {
      const arr = childrenByParent.get(inferred) ?? [];
      arr.push(e);
      childrenByParent.set(inferred, arr);
    } else {
      topLevel.push(e);
    }
  });

  topLevel.sort((a, b) => a.label.localeCompare(b.label));

  const standalones: DiscoveredEntry[] = [];
  const categories: Category[] = [];
  topLevel.forEach(parent => {
    const children = (childrenByParent.get(parent.name) ?? []).slice();
    if (children.length === 0) {
      standalones.push(parent);
    } else {
      children.sort((a, b) => a.label.localeCompare(b.label));
      categories.push({ parent, children });
    }
  });

  orphans.sort((a, b) => a.entry.label.localeCompare(b.entry.label));

  return { standalones, categories, orphans };
}

export default function SidebarSettingsPage() {
  const discovered = useDiscovered();
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(loadSettings().hidden));
  const [savedHidden, setSavedHidden] = useState<Set<string>>(() => new Set(loadSettings().hidden));
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === 'click-ops:sidebar-settings') {
        const next = new Set(loadSettings().hidden);
        setHidden(next);
        setSavedHidden(next);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const dirty = useMemo(() => {
    if (hidden.size !== savedHidden.size) return true;
    for (const v of hidden) if (!savedHidden.has(v)) return true;
    return false;
  }, [hidden, savedHidden]);

  const layout = useMemo(() => buildLayout(discovered), [discovered]);

  const totalToggleable = useMemo(
    () => discovered.filter(e => !OWN_ENTRIES.has(e.name)).length,
    [discovered],
  );
  const hiddenToggleable = useMemo(
    () => [...hidden].filter(n => !OWN_ENTRIES.has(n)).length,
    [hidden],
  );

  function toggle(name: string) {
    setHidden(prev => {
      const next = new Set(prev);
      const wasHidden = next.has(name);
      if (wasHidden) next.delete(name);
      else next.add(name);

      let ownerCategory: Category | null = null;
      let isParent = false;
      for (const c of layout.categories) {
        if (c.parent.name === name) { ownerCategory = c; isParent = true; break; }
        if (c.children.some(child => child.name === name)) { ownerCategory = c; break; }
      }

      if (ownerCategory && !isParent) {
        if (!wasHidden) {
          const allChildrenHidden = ownerCategory.children.every(c => next.has(c.name));
          if (allChildrenHidden) next.add(ownerCategory.parent.name);
        } else if (next.has(ownerCategory.parent.name)) {
          next.delete(ownerCategory.parent.name);
        }
      }

      return next;
    });
  }

  function toggleCategory(c: Category, hideAll: boolean) {
    setHidden(prev => {
      const next = new Set(prev);
      const all: DiscoveredEntry[] = [c.parent, ...c.children];
      all.forEach(e => {
        if (hideAll) next.add(e.name);
        else next.delete(e.name);
      });
      return next;
    });
  }

  function onSave() {
    const list = [...hidden];
    saveSettings({ hidden: list });
    setSavedHidden(new Set(list));
    setSavedAt(Date.now());
    registerSidebarEntryFilter(e => e);
  }

  function onReset() {
    setHidden(new Set(savedHidden));
  }

  function onReload() {
    window.location.reload();
  }

  return (
    <SectionBox textAlign="left">
      <Box sx={{ mt: 3, mb: 3 }}>
        <Typography variant="h5" sx={{ mb: 0.5 }}>
          Sidebar Settings
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Tick entries to hide them from the sidebar — un-tick anytime here to bring them
          back. Headlamp's plugin filter API only supports show/hide (no reparenting), so a
          collapsible "More" submenu isn't possible. Click <strong>Save</strong> and the
          sidebar updates straight away — no Headlamp restart needed.
        </Typography>
      </Box>

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="h6">Sidebar entries</Typography>
          <Stack direction="row" spacing={1}>
            <Chip
              size="small"
              label={`${totalToggleable - hiddenToggleable} visible`}
              color="success"
              variant="outlined"
            />
            <Chip
              size="small"
              label={`${hiddenToggleable} hidden`}
              color="default"
              variant="outlined"
            />
          </Stack>
        </Stack>

        {discovered.length === 0 ? (
          <Alert severity="info">
            No sidebar entries discovered yet. Open any cluster view once so Headlamp
            renders the sidebar — then come back here.
          </Alert>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">Hide</TableCell>
                <TableCell sx={{ width: 56 }}>Icon</TableCell>
                <TableCell>Label</TableCell>
                <TableCell>Name</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {layout.standalones.length > 0 && (
                <>
                  <TableRow>
                    <TableCell colSpan={4} sx={{ backgroundColor: 'action.hover', py: 0.5 }}>
                      <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 600 }}>
                        Standalone (no sub-items)
                      </Typography>
                    </TableCell>
                  </TableRow>
                  {layout.standalones.map(e => {
                    const isOwn = OWN_ENTRIES.has(e.name);
                    return (
                      <TableRow hover key={e.name}>
                        <TableCell padding="checkbox">
                          <Checkbox
                            checked={hidden.has(e.name)}
                            onChange={() => toggle(e.name)}
                            inputProps={{ 'aria-label': `Hide ${e.label}` }}
                          />
                        </TableCell>
                        <TableCell>
                          {typeof e.icon === 'string' ? (
                            <Icon icon={e.icon as string} width={20} height={20} />
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2">{e.label}</Typography>
                        </TableCell>
                        <TableCell>
                          <Typography variant="caption" sx={{ fontFamily: 'monospace', display: 'block' }}>
                            {e.name}
                            {isOwn && (
                              <Chip size="small" label="own" sx={{ ml: 1 }} variant="outlined" />
                            )}
                          </Typography>
                          {e.url && (
                            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', display: 'block' }}>
                              {e.url}
                            </Typography>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </>
              )}

              {layout.categories.length > 0 && (
                <>
                  <TableRow>
                    <TableCell colSpan={4} sx={{ backgroundColor: 'action.hover', py: 0.5 }}>
                      <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 600 }}>
                        With sub-items
                      </Typography>
                    </TableCell>
                  </TableRow>
                  {layout.categories.map(c => {
                    const isOwnParent = OWN_ENTRIES.has(c.parent.name);
                    const groupAll: DiscoveredEntry[] = [c.parent, ...c.children].filter(
                      e => !OWN_ENTRIES.has(e.name),
                    );
                    const hiddenCount = groupAll.filter(e => hidden.has(e.name)).length;
                    const allHidden = groupAll.length > 0 && hiddenCount === groupAll.length;
                    const someHidden = hiddenCount > 0 && hiddenCount < groupAll.length;

                    return (
                      <React.Fragment key={c.parent.name}>
                        <TableRow hover sx={{ '& > td': { borderBottom: 'none' } }}>
                          <TableCell padding="checkbox">
                            <Checkbox
                              checked={allHidden}
                              indeterminate={someHidden}
                              onChange={() => toggleCategory(c, !allHidden)}
                              inputProps={{ 'aria-label': `Hide ${c.parent.label} and its sub-items` }}
                            />
                          </TableCell>
                          <TableCell>
                            {typeof c.parent.icon === 'string' ? (
                              <Icon icon={c.parent.icon as string} width={22} height={22} />
                            ) : null}
                          </TableCell>
                          <TableCell>
                            <Typography variant="body2" sx={{ fontWeight: 700 }}>
                              {c.parent.label}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {c.children.length} sub-item{c.children.length === 1 ? '' : 's'}
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Typography variant="caption" sx={{ fontFamily: 'monospace', display: 'block' }}>
                              {c.parent.name}
                              {isOwnParent && (
                                <Chip size="small" label="own" sx={{ ml: 1 }} variant="outlined" />
                              )}
                            </Typography>
                            {c.parent.url && (
                              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', display: 'block' }}>
                                {c.parent.url}
                              </Typography>
                            )}
                          </TableCell>
                        </TableRow>
                        {c.children.map((child, idx) => {
                          const isOwn = OWN_ENTRIES.has(child.name);
                          const isLast = idx === c.children.length - 1;
                          return (
                            <TableRow hover key={child.name}>
                              <TableCell padding="checkbox">
                                <Checkbox
                                  checked={hidden.has(child.name)}
                                  onChange={() => toggle(child.name)}
                                  inputProps={{ 'aria-label': `Hide ${child.label}` }}
                                />
                              </TableCell>
                              <TableCell sx={{ p: 0, position: 'relative' }}>
                                <Box
                                  sx={{
                                    position: 'absolute',
                                    left: 18,
                                    top: 0,
                                    bottom: isLast ? '50%' : 0,
                                    width: 0,
                                    borderLeft: '2px solid',
                                    borderColor: 'divider',
                                  }}
                                />
                                <Box
                                  sx={{
                                    position: 'absolute',
                                    left: 18,
                                    top: '50%',
                                    width: 14,
                                    height: 0,
                                    borderTop: '2px solid',
                                    borderColor: 'divider',
                                  }}
                                />
                                <Box sx={{ pl: 5, display: 'flex', alignItems: 'center', minHeight: 32 }}>
                                  {typeof child.icon === 'string' ? (
                                    <Icon icon={child.icon as string} width={18} height={18} />
                                  ) : null}
                                </Box>
                              </TableCell>
                              <TableCell>
                                <Typography variant="body2" color="text.secondary">
                                  {child.label}
                                </Typography>
                              </TableCell>
                              <TableCell>
                                <Typography variant="caption" sx={{ fontFamily: 'monospace', display: 'block' }}>
                                  {child.name}
                                  {isOwn && (
                                    <Chip
                                      size="small"
                                      label="own"
                                      sx={{ ml: 1 }}
                                      variant="outlined"
                                    />
                                  )}
                                </Typography>
                                {child.url && (
                                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', display: 'block' }}>
                                    {child.url}
                                  </Typography>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </React.Fragment>
                    );
                  })}
                </>
              )}

              {layout.orphans.length > 0 && (
                <>
                  <TableRow>
                    <TableCell colSpan={4} sx={{ backgroundColor: 'action.hover', py: 0.5 }}>
                      <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 600 }}>
                        Detached (parent not registered)
                      </Typography>
                    </TableCell>
                  </TableRow>
                  {layout.orphans.map(o => (
                    <TableRow hover key={o.entry.name}>
                      <TableCell padding="checkbox">
                        <Checkbox
                          checked={hidden.has(o.entry.name)}
                          onChange={() => toggle(o.entry.name)}
                          inputProps={{ 'aria-label': `Hide ${o.entry.label}` }}
                        />
                      </TableCell>
                      <TableCell>
                        {typeof o.entry.icon === 'string' ? (
                          <Icon icon={o.entry.icon as string} width={18} height={18} />
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2">{o.entry.label}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          parent: <code>{o.missingParentName}</code>
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                          {o.entry.name}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ))}
                </>
              )}
            </TableBody>
          </Table>
        )}
      </Paper>

      {savedAt !== null && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSavedAt(null)}>
          Saved — sidebar updated.
        </Alert>
      )}

      <Divider sx={{ mb: 2 }} />

      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        justifyContent="flex-end"
        sx={{ pb: 2 }}
      >
        <Button
          variant="text"
          onClick={onReset}
          disabled={!dirty}
          startIcon={<Icon icon="mdi:undo" />}
        >
          Reset changes
        </Button>
        <Button
          variant="outlined"
          onClick={onReload}
          startIcon={<Icon icon="mdi:reload" />}
        >
          Reload Headlamp
        </Button>
        <Button
          variant="contained"
          onClick={onSave}
          disabled={!dirty}
          startIcon={<Icon icon="mdi:content-save" />}
        >
          Save
        </Button>
      </Stack>
    </SectionBox>
  );
}
