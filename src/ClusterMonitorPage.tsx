import { Icon } from '@iconify/react';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ClusterMetricsResult,
  fetchClusterMetrics,
  fetchPvcs,
  fetchTopPods,
  formatAge,
  formatBytes,
  formatCores,
  NodeRow,
  pct,
  PodMetricRow,
  pvcKey,
  PvcRow,
  sumNullable,
  sumNumbers,
} from './lib/metrics';

const REFRESH_MS = 15000;

function barColor(p: number | null): 'success' | 'warning' | 'error' | 'primary' {
  if (p === null) return 'primary';
  if (p >= 90) return 'error';
  if (p >= 75) return 'warning';
  return 'success';
}

function SummaryCard({
  icon,
  label,
  used,
  capacity,
  formatter,
}: {
  icon: string;
  label: string;
  used: number | null;
  capacity: number | null;
  formatter: (v: number | null) => string;
}) {
  const p = pct(used, capacity);
  return (
    <Paper variant="outlined" sx={{ p: 2, flex: 1, minWidth: 220 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <Icon icon={icon} width={20} />
        <Typography variant="subtitle2" color="text.secondary">
          {label}
        </Typography>
      </Stack>
      <Typography variant="h5" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {formatter(used)}{' '}
        <Typography component="span" variant="body2" color="text.secondary">
          / {formatter(capacity)}
        </Typography>
      </Typography>
      <Box sx={{ mt: 1 }}>
        <LinearProgress
          variant={p === null ? 'indeterminate' : 'determinate'}
          value={p ?? 0}
          color={barColor(p)}
        />
        <Typography variant="caption" color="text.secondary">
          {p === null ? 'no data' : `${p.toFixed(1)}%`}
        </Typography>
      </Box>
    </Paper>
  );
}

function UsageBar({
  used,
  capacity,
  formatter,
}: {
  used: number | null;
  capacity: number | null;
  formatter: (v: number | null) => string;
}) {
  const p = pct(used, capacity);
  return (
    <Box sx={{ minWidth: 160 }}>
      <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {formatter(used)} / {formatter(capacity)}
        {p !== null && ` (${p.toFixed(0)}%)`}
      </Typography>
      <LinearProgress
        variant={p === null ? 'indeterminate' : 'determinate'}
        value={p ?? 0}
        color={barColor(p)}
        sx={{ mt: 0.5, height: 6, borderRadius: 1 }}
      />
    </Box>
  );
}

const TOP_N = 5;

export default function ClusterMonitorPage() {
  const [data, setData] = useState<ClusterMetricsResult | null>(null);
  const [pvcs, setPvcs] = useState<PvcRow[]>([]);
  const [pvcError, setPvcError] = useState<string | null>(null);
  const [pods, setPods] = useState<PodMetricRow[]>([]);
  const [podError, setPodError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [result, pvcResult, podResult] = await Promise.all([
        fetchClusterMetrics(),
        fetchPvcs().then(
          rows => ({ rows, error: null as string | null }),
          err => ({ rows: [] as PvcRow[], error: err instanceof Error ? err.message : String(err) }),
        ),
        fetchTopPods(),
      ]);
      setData(result);
      setPvcs(pvcResult.rows);
      setPvcError(pvcResult.error);
      setPods(podResult.rows);
      setPodError(podResult.error);
      setLastUpdate(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const handle = setInterval(load, REFRESH_MS);
    return () => clearInterval(handle);
  }, [load]);

  const nodes: NodeRow[] = data?.nodes ?? [];
  const totalCpuUsed = sumNullable(nodes.map(n => n.cpuUsed));
  const totalCpuCap = sumNumbers(nodes.map(n => n.cpuCapacity));
  const totalMemUsed = sumNullable(nodes.map(n => n.memUsedBytes));
  const totalMemCap = sumNumbers(nodes.map(n => n.memCapacityBytes));
  const totalDiskUsed = sumNullable(nodes.map(n => n.rootFsUsedBytes));
  const totalDiskCap = sumNullable(nodes.map(n => n.rootFsCapacityBytes));

  const diskUnavailable = nodes.length > 0 && nodes.every(n => n.rootFsCapacityBytes === null);

  const totalPvcCapacity = pvcs.reduce((s, p) => s + p.capacityBytes, 0);
  const volumeUsage = data?.volumeUsageByPvc ?? new Map();
  const totalPvcUsed = pvcs.reduce(
    (s, p) => s + (volumeUsage.get(pvcKey(p.namespace, p.name))?.usedBytes ?? 0),
    0,
  );
  const pvcsWithUsage = pvcs.filter(p => volumeUsage.has(pvcKey(p.namespace, p.name))).length;
  const topCpuPods = [...pods].sort((a, b) => b.cpuCores - a.cpuCores).slice(0, TOP_N);
  const topMemPods = [...pods].sort((a, b) => b.memoryBytes - a.memoryBytes).slice(0, TOP_N);

  return (
    <SectionBox textAlign="left">
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'flex-start', md: 'center' }}
        spacing={1}
        sx={{ mt: 0, mb: 2 }}
      >
        <Box>
          <Typography variant="h5" sx={{ mb: 0.5 }}>
            Cluster Monitor
          </Typography>
          <Typography variant="body2" color="text.secondary">
            CPU, memory and disk usage per node — refreshed every {REFRESH_MS / 1000}s. CPU and
            memory come from metrics-server; disk comes from the kubelet stats summary
            (<code>nodes/proxy</code> RBAC required).
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          {lastUpdate && (
            <Typography variant="caption" color="text.secondary">
              Updated {lastUpdate.toLocaleTimeString()}
            </Typography>
          )}
          <Tooltip title="Refresh now">
            <span>
              <IconButton size="small" onClick={load} disabled={loading}>
                <Icon icon="mdi:refresh" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {data?.metricsServerError && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          metrics-server unavailable — CPU and memory usage cannot be shown. Install metrics-server
          to enable. ({data.metricsServerError})
        </Alert>
      )}
      {diskUnavailable && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Disk usage is unavailable for all nodes. Most likely the user can't access
          <code> nodes/proxy</code> (cluster-admin can; otherwise add the RBAC verb).
        </Alert>
      )}

      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mb: 2 }}>
        <SummaryCard
          icon="mdi:cpu-64-bit"
          label="CPU (cores)"
          used={totalCpuUsed}
          capacity={totalCpuCap || null}
          formatter={formatCores}
        />
        <SummaryCard
          icon="mdi:memory"
          label="Memory"
          used={totalMemUsed}
          capacity={totalMemCap || null}
          formatter={formatBytes}
        />
        <SummaryCard
          icon="mdi:harddisk"
          label="Disk (root fs)"
          used={totalDiskUsed}
          capacity={totalDiskCap}
          formatter={formatBytes}
        />
      </Stack>

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Typography variant="h6">Nodes</Typography>
          {loading && <CircularProgress size={18} />}
        </Stack>
        {nodes.length === 0 && !loading ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
            No nodes found.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>CPU</TableCell>
                <TableCell>Memory</TableCell>
                <TableCell>Root FS</TableCell>
                <TableCell>Image FS</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {nodes.map(n => (
                <TableRow key={n.name} hover>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                      {n.name}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={n.ready ? 'Ready' : 'NotReady'}
                      color={n.ready ? 'success' : 'error'}
                      variant={n.ready ? 'outlined' : 'filled'}
                    />
                  </TableCell>
                  <TableCell>
                    <UsageBar
                      used={n.cpuUsed}
                      capacity={n.cpuCapacity || null}
                      formatter={formatCores}
                    />
                  </TableCell>
                  <TableCell>
                    <UsageBar
                      used={n.memUsedBytes}
                      capacity={n.memCapacityBytes || null}
                      formatter={formatBytes}
                    />
                  </TableCell>
                  <TableCell>
                    <UsageBar
                      used={n.rootFsUsedBytes}
                      capacity={n.rootFsCapacityBytes}
                      formatter={formatBytes}
                    />
                  </TableCell>
                  <TableCell>
                    <UsageBar
                      used={n.imageFsUsedBytes}
                      capacity={n.imageFsCapacityBytes}
                      formatter={formatBytes}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>

      <Stack direction={{ xs: 'column', lg: 'row' }} spacing={2} sx={{ mt: 2 }}>
        <Paper variant="outlined" sx={{ p: 2, flex: 1 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
            <Typography variant="h6">Top pods by CPU</Typography>
            <Typography variant="caption" color="text.secondary">
              top {TOP_N} of {pods.length}
            </Typography>
          </Stack>
          {podError ? (
            <Alert severity="warning">metrics-server unavailable ({podError})</Alert>
          ) : topCpuPods.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
              No pod metrics yet.
            </Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Pod</TableCell>
                  <TableCell align="right">CPU</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {topCpuPods.map(p => (
                  <TableRow hover key={`${p.namespace}/${p.name}`}>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                        {p.namespace}/{p.name}
                      </Typography>
                    </TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      {formatCores(p.cpuCores)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Paper>

        <Paper variant="outlined" sx={{ p: 2, flex: 1 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
            <Typography variant="h6">Top pods by memory</Typography>
            <Typography variant="caption" color="text.secondary">
              top {TOP_N} of {pods.length}
            </Typography>
          </Stack>
          {podError ? (
            <Alert severity="warning">metrics-server unavailable ({podError})</Alert>
          ) : topMemPods.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
              No pod metrics yet.
            </Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Pod</TableCell>
                  <TableCell align="right">Memory</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {topMemPods.map(p => (
                  <TableRow hover key={`${p.namespace}/${p.name}`}>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                        {p.namespace}/{p.name}
                      </Typography>
                    </TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      {formatBytes(p.memoryBytes)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Paper>
      </Stack>

      <Paper variant="outlined" sx={{ p: 2, mt: 2 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Typography variant="h6">PersistentVolumeClaims</Typography>
          <Typography variant="caption" color="text.secondary">
            {pvcs.length} PVCs · {formatBytes(totalPvcCapacity)} requested
            {pvcsWithUsage > 0 && (
              <>
                {' '}· {formatBytes(totalPvcUsed)} used across {pvcsWithUsage} mounted
              </>
            )}
          </Typography>
        </Stack>
        {pvcs.length > 0 && pvcsWithUsage === 0 && (
          <Alert severity="info" sx={{ mb: 1 }}>
            Per-PVC usage is not reported by your cluster's storage driver. The microk8s in-tree
            hostpath provisioner doesn't expose volume stats — only capacity is shown. To get
            real usage, install a CSI driver (e.g. OpenEBS, Longhorn, csi-driver-host-path).
          </Alert>
        )}
        {pvcError ? (
          <Alert severity="error">{pvcError}</Alert>
        ) : pvcs.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
            No PVCs in the cluster.
          </Typography>
        ) : (
          <>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              Usage comes from kubelet stats — only mounted PVCs on stat-reporting drivers show
              numbers. The rest stay "—".
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Namespace</TableCell>
                  <TableCell>Name</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Used / Capacity</TableCell>
                  <TableCell>StorageClass</TableCell>
                  <TableCell align="right">Age</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {pvcs.map(p => {
                  const usage = volumeUsage.get(pvcKey(p.namespace, p.name));
                  return (
                    <TableRow hover key={`${p.namespace}/${p.name}`}>
                      <TableCell>
                        <Chip size="small" label={p.namespace} />
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                          {p.name}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          label={p.status}
                          color={p.status === 'Bound' ? 'success' : 'warning'}
                          variant={p.status === 'Bound' ? 'outlined' : 'filled'}
                        />
                      </TableCell>
                      <TableCell>
                        {usage ? (
                          <UsageBar
                            used={usage.usedBytes}
                            capacity={usage.capacityBytes || p.capacityBytes}
                            formatter={formatBytes}
                          />
                        ) : (
                          <Typography variant="caption" color="text.secondary">
                            — / {formatBytes(p.capacityBytes)}
                          </Typography>
                        )}
                      </TableCell>
                      <TableCell>
                        <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                          {p.storageClass}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        <Typography variant="caption">{formatAge(p.ageMs)}</Typography>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </>
        )}
      </Paper>
      <Box sx={{ height: 16 }} />
    </SectionBox>
  );
}
