import { Icon } from '@iconify/react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import React from 'react';
import { ChangeAction, destructiveChanges, PlannedChange } from './lib/plan';

const ACTION_STYLE: Record<
  ChangeAction,
  { icon: string; color: string; label: string }
> = {
  create: { icon: 'mdi:plus-circle-outline', color: '#4caf50', label: 'create' },
  update: { icon: 'mdi:circle-small', color: '#9e9e9e', label: 'apply' },
  recreate: { icon: 'mdi:autorenew', color: '#ed6c02', label: 'recreate' },
  delete: { icon: 'mdi:minus-circle-outline', color: '#f44336', label: 'delete' },
};

function ChangeRow({ change }: { change: PlannedChange }) {
  const style = ACTION_STYLE[change.action];
  return (
    <Stack direction="row" spacing={1.5} alignItems="flex-start" sx={{ py: 0.5 }}>
      <Box sx={{ pt: 0.25 }}>
        <Icon icon={style.icon} width={20} color={style.color} />
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
          {style.label} {change.kind}/{change.name}
          {change.namespace ? ` in ${change.namespace}` : ''}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {change.reason}
        </Typography>
      </Box>
    </Stack>
  );
}

export default function PlanDialog({
  open,
  accountName,
  changes,
  applying,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  accountName: string;
  changes: PlannedChange[];
  applying: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const destructive = destructiveChanges(changes);
  const removals = changes.filter(c => c.action === 'delete');

  return (
    <Dialog open={open} onClose={applying ? undefined : onCancel} fullWidth maxWidth="sm">
      <DialogTitle>
        Apply changes to &quot;{accountName}&quot;
      </DialogTitle>
      <DialogContent dividers>
        {destructive.length > 0 ? (
          <Alert severity="warning" sx={{ mb: 2 }}>
            <AlertTitle>
              {removals.length > 0
                ? `${removals.length} object${removals.length === 1 ? '' : 's'} will be deleted.`
                : 'Some bindings will be recreated.'}
            </AlertTitle>
            Deleting a RoleBinding takes that access away immediately. Recreated bindings are
            briefly absent while the roleRef changes, because Kubernetes does not allow it to
            be edited in place.
          </Alert>
        ) : (
          <Alert severity="info" sx={{ mb: 2 }}>
            Nothing is removed — this only creates or updates objects.
          </Alert>
        )}

        <Stack direction="row" spacing={1} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
          {(['create', 'update', 'recreate', 'delete'] as ChangeAction[]).map(a => {
            const count = changes.filter(c => c.action === a).length;
            if (count === 0) return null;
            return (
              <Chip
                key={a}
                size="small"
                label={`${count} ${ACTION_STYLE[a].label}`}
                color={a === 'delete' ? 'error' : a === 'recreate' ? 'warning' : 'default'}
                variant={a === 'update' ? 'outlined' : 'filled'}
              />
            );
          })}
        </Stack>

        <Box>
          {changes.map((c, i) => (
            <ChangeRow key={`${c.kind}/${c.namespace ?? ''}/${c.name}/${i}`} change={c} />
          ))}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={applying}>
          Cancel
        </Button>
        <Button
          variant="contained"
          color={destructive.length > 0 ? 'warning' : 'primary'}
          onClick={onConfirm}
          disabled={applying}
        >
          {applying ? 'Applying…' : 'Apply'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
