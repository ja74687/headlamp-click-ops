import { Icon } from '@iconify/react';
import {
  Alert,
  Chip,
  CircularProgress,
  FormControlLabel,
  IconButton,
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
import React from 'react';

type KvItem = { metadata: { name: string; namespace: string }; data?: Record<string, string> };

/** The list half of the ConfigMaps and Secrets tabs: switches, filter and the table itself. */
export default function KvResourceTable<T extends KvItem>({
  title,
  items,
  listError,
  onClearError,
  hideSystem,
  onHideSystemChange,
  filter,
  onFilterChange,
  onRefresh,
  onEdit,
  onDelete,
  typeOf,
}: {
  title: string;
  /** null while the first load is running. */
  items: T[] | null;
  listError: string | null;
  onClearError: () => void;
  hideSystem: boolean;
  onHideSystemChange: (v: boolean) => void;
  filter: string;
  onFilterChange: (v: string) => void;
  onRefresh: () => void;
  onEdit: (item: T) => void;
  onDelete: (item: T) => void;
  /** Adds a Type column when given. */
  typeOf?: (item: T) => string;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
        <Typography variant="h6">{title}</Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          <FormControlLabel
            control={
              <Switch checked={hideSystem} onChange={e => onHideSystemChange(e.target.checked)} />
            }
            label={<Typography variant="body2">Hide system</Typography>}
          />
          <Tooltip title="Refresh">
            <IconButton onClick={onRefresh} size="small" aria-label="Refresh">
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
          onChange={e => onFilterChange(e.target.value)}
          sx={{ flex: 1 }}
        />
      </Stack>

      {listError && (
        <Alert severity="error" sx={{ mb: 1 }} onClose={onClearError}>
          {listError}
        </Alert>
      )}
      {items === null ? (
        <Stack alignItems="center" sx={{ py: 3 }}>
          <CircularProgress size={24} />
        </Stack>
      ) : items.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          No {title} match the filters.
        </Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Namespace</TableCell>
              {typeOf && <TableCell>Type</TableCell>}
              <TableCell>Keys</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map(item => (
              <TableRow hover key={`${item.metadata.namespace}/${item.metadata.name}`}>
                <TableCell>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                    {item.metadata.name}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Chip size="small" label={item.metadata.namespace} />
                </TableCell>
                {typeOf && (
                  <TableCell>
                    <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                      {typeOf(item)}
                    </Typography>
                  </TableCell>
                )}
                <TableCell>
                  <Typography variant="caption" color="text.secondary">
                    {Object.keys(item.data ?? {}).length} keys
                  </Typography>
                </TableCell>
                <TableCell align="right">
                  <Tooltip title="Edit">
                    <IconButton size="small" onClick={() => onEdit(item)} aria-label="Edit">
                      <Icon icon="mdi:pencil-outline" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title="Delete">
                    <IconButton
                      size="small"
                      onClick={() => onDelete(item)}
                      color="error"
                      aria-label="Delete"
                    >
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
  );
}
