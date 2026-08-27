import { Icon } from '@iconify/react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import React, { useCallback, useEffect, useState } from 'react';
import {
  CleanupOutcome,
  deleteOrphans,
  findOrphans,
  groupByAccount,
  Orphan,
} from './lib/orphans';

export default function OrphansPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [orphans, setOrphans] = useState<Orphan[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<CleanupOutcome[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setOutcomes(null);
    try {
      const report = await findOrphans();
      setOrphans(report.orphans);
      setErrors(report.errors);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function cleanUp() {
    if (!orphans) return;
    setBusy(true);
    try {
      const result = await deleteOrphans(orphans);
      setOutcomes(result);
      await load();
    } finally {
      setBusy(false);
    }
  }

  // Nothing to say when the cluster is tidy; the panel stays out of the way.
  if (!loading && orphans !== null && orphans.length === 0 && errors.length === 0 && !outcomes) {
    return null;
  }

  const grouped = groupByAccount(orphans ?? []);
  const failed = outcomes?.filter(o => !o.ok) ?? [];

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Box>
          <Typography variant="h6">Leftovers</Typography>
          <Typography variant="body2" color="text.secondary">
            Objects this plugin created whose ServiceAccount is gone.
          </Typography>
        </Box>
        {loading && <CircularProgress size={20} />}
      </Stack>

      {errors.map((e, i) => (
        <Alert severity="warning" sx={{ mt: 1 }} key={i}>
          {e}
        </Alert>
      ))}

      {outcomes && (
        <Alert severity={failed.length === 0 ? 'success' : 'warning'} sx={{ mt: 1 }}>
          {failed.length === 0
            ? `Removed ${outcomes.length} object${outcomes.length === 1 ? '' : 's'}.`
            : `${failed.length} of ${outcomes.length} could not be removed: ${failed
                .map(f => `${f.orphan.kind}/${f.orphan.name}`)
                .join(', ')}`}
        </Alert>
      )}

      {orphans && orphans.length > 0 && (
        <>
          <Alert severity="warning" sx={{ mt: 1 }}>
            <AlertTitle>
              {orphans.length} leftover object{orphans.length === 1 ? '' : 's'} from{' '}
              {grouped.size} deleted account{grouped.size === 1 ? '' : 's'}.
            </AlertTitle>
            Recreating a ServiceAccount with one of these names would silently inherit every
            permission the old one had.
          </Alert>

          <Stack direction="row" spacing={1} sx={{ mt: 1 }} alignItems="center">
            <Button
              size="small"
              onClick={() => setExpanded(e => !e)}
              startIcon={<Icon icon={expanded ? 'mdi:chevron-up' : 'mdi:chevron-down'} />}
            >
              {expanded ? 'Hide' : 'Show'} details
            </Button>
            <Button
              size="small"
              color="error"
              variant="outlined"
              disabled={busy}
              startIcon={<Icon icon="mdi:broom" />}
              onClick={cleanUp}
            >
              {busy ? 'Removing…' : 'Remove all'}
            </Button>
          </Stack>

          <Collapse in={expanded}>
            <Box sx={{ mt: 1 }}>
              {[...grouped.entries()].map(([account, items]) => (
                <Box key={account} sx={{ mb: 1.5 }}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography variant="subtitle2" sx={{ fontFamily: 'monospace' }}>
                      {account}
                    </Typography>
                    <Chip size="small" label={`${items.length} objects`} />
                  </Stack>
                  {items.map(o => (
                    <Typography
                      key={o.id}
                      variant="caption"
                      component="div"
                      color="text.secondary"
                      sx={{ fontFamily: 'monospace', pl: 1 }}
                    >
                      {o.kind}/{o.name}
                      {o.namespace ? ` in ${o.namespace}` : ''}
                    </Typography>
                  ))}
                </Box>
              ))}
            </Box>
          </Collapse>
        </>
      )}
    </Paper>
  );
}
