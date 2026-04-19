import { Icon } from '@iconify/react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
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
import { listManagedAccounts, ManagedAccount } from './lib/discovery';

export type ManagedAccountsListProps = {
  onEdit: (account: ManagedAccount) => void;
  onDelete: (account: ManagedAccount) => Promise<void>;
  onDownload: (account: ManagedAccount) => Promise<void>;
  refreshKey?: number;
};

export default function ManagedAccountsList({
  onEdit,
  onDelete,
  onDownload,
  refreshKey = 0,
}: ManagedAccountsListProps) {
  const [accounts, setAccounts] = useState<ManagedAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await listManagedAccounts();
      setAccounts(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function runAction(name: string, fn: () => Promise<void>) {
    setBusyName(name);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyName(null);
    }
  }

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
        <Box>
          <Typography variant="h6">Managed accounts</Typography>
          <Typography variant="body2" color="text.secondary">
            ServiceAccounts labelled <code>app.kubernetes.io/managed-by=headlamp-access-builder</code>.
          </Typography>
        </Box>
        <Tooltip title="Refresh">
          <IconButton onClick={load} size="small" aria-label="Refresh list">
            <Icon icon="mdi:refresh" />
          </IconButton>
        </Tooltip>
      </Stack>

      {error && (
        <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}

      {accounts === null ? (
        <Stack alignItems="center" sx={{ py: 3 }}>
          <CircularProgress size={24} />
        </Stack>
      ) : accounts.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          No accounts yet. Use the form below to create one.
        </Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Scope</TableCell>
              <TableCell>Namespaces</TableCell>
              <TableCell>Token Secret</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {accounts.map(a => (
              <TableRow key={`${a.namespace}/${a.name}`} hover>
                <TableCell>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                    {a.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    SA in {a.namespace}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Chip
                    size="small"
                    label={a.scope === 'Cluster' ? 'Cluster-wide' : `Namespaced (${a.roleKind})`}
                    color={a.scope === 'Cluster' ? 'warning' : 'default'}
                  />
                </TableCell>
                <TableCell>
                  {a.scope === 'Cluster' ? (
                    <Typography variant="body2" color="text.secondary">
                      all
                    </Typography>
                  ) : a.bindingNamespaces.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      —
                    </Typography>
                  ) : (
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                      {a.bindingNamespaces.map(ns => (
                        <Chip key={ns} size="small" label={ns} />
                      ))}
                    </Stack>
                  )}
                </TableCell>
                <TableCell>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                    {a.tokenSecretName}
                  </Typography>
                </TableCell>
                <TableCell align="right">
                  <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                    <Tooltip title="Download kubeconfig">
                      <span>
                        <IconButton
                          size="small"
                          disabled={busyName === a.name}
                          onClick={() => runAction(a.name, () => onDownload(a))}
                          aria-label="Download kubeconfig"
                        >
                          <Icon icon="mdi:download" />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title="Edit">
                      <span>
                        <IconButton
                          size="small"
                          disabled={busyName === a.name}
                          onClick={() => onEdit(a)}
                          aria-label="Edit account"
                        >
                          <Icon icon="mdi:pencil-outline" />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title="Delete (cascades to Role/Bindings/Secret)">
                      <span>
                        <Button
                          size="small"
                          color="error"
                          variant="text"
                          disabled={busyName === a.name}
                          startIcon={<Icon icon="mdi:delete-outline" />}
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete account "${a.name}" and all its RBAC resources? This cannot be undone.`,
                              )
                            ) {
                              runAction(a.name, () => onDelete(a));
                            }
                          }}
                        >
                          Delete
                        </Button>
                      </span>
                    </Tooltip>
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Paper>
  );
}
