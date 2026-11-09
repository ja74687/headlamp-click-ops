import { Icon } from '@iconify/react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from '@mui/material';
import React, { useEffect, useState } from 'react';
import {
  AccessCheckReport,
  AccessCheckResult,
  isBlocking,
  runAccessChecks,
  serviceAccountUser,
} from './lib/accessCheck';
import { ManagedAccount } from './lib/discovery';

function StatusIcon({ allowed }: { allowed: boolean | null }) {
  if (allowed === null) {
    return <Icon icon="mdi:help-circle-outline" width={20} color="#9e9e9e" />;
  }
  return allowed ? (
    <Icon icon="mdi:check-circle" width={20} color="#4caf50" />
  ) : (
    <Icon icon="mdi:close-circle" width={20} color="#f44336" />
  );
}

function ResultRow({ result }: { result: AccessCheckResult }) {
  const blocking = isBlocking(result);
  return (
    <Stack direction="row" spacing={1.5} alignItems="flex-start" sx={{ py: 0.75 }}>
      <Box sx={{ pt: 0.25 }}>
        <StatusIcon allowed={result.allowed} />
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography
          variant="body2"
          sx={{ fontFamily: 'monospace' }}
          color={blocking ? 'error.main' : 'text.primary'}
        >
          {result.label}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {result.allowed === false ? 'Blocks ' : 'Enables '}
          {result.enables}
          {result.allowed === null && result.reason ? ` — ${result.reason}` : ''}
        </Typography>
      </Box>
    </Stack>
  );
}

export default function AccessCheckDialog({
  account,
  onClose,
}: {
  account: ManagedAccount | null;
  onClose: () => void;
}) {
  const [report, setReport] = useState<AccessCheckReport | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!account) {
      setReport(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setReport(null);
    runAccessChecks({
      namespace: account.namespace,
      name: account.name,
      boundNamespaces: account.bindingNamespaces,
      scope: account.scope,
      rules: account.rules,
    })
      .then(r => {
        if (!cancelled) setReport(r);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account]);

  const results = report?.results ?? [];
  const blocked = results.filter(isBlocking);
  const denied = results.filter(r => r.allowed === false);

  return (
    <Dialog open={!!account} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Access check</DialogTitle>
      <DialogContent dividers>
        {account && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Asking the API server what{' '}
            <code>{serviceAccountUser(account.namespace, account.name)}</code> is allowed to do,
            via SubjectAccessReview.
          </Typography>
        )}

        {loading && (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 2 }}>
            <CircularProgress size={18} />
            <Typography variant="body2">Running checks…</Typography>
          </Stack>
        )}

        {report?.error && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            <AlertTitle>Could not run the checks.</AlertTitle>
            {report.error}
          </Alert>
        )}

        {!loading && !report?.error && results.length > 0 && (
          <>
            {blocked.length > 0 ? (
              <Alert severity="error" sx={{ mb: 2 }}>
                <AlertTitle>This account cannot use Headlamp.</AlertTitle>
                {blocked.some(r => r.id === 'namespaces') ? (
                  <>
                    Raise <strong>Headlamp UI access</strong> in the form below and save — the
                    red rows say what is missing.
                  </>
                ) : (
                  <>
                    Its own rules do not take effect in the namespaces marked red. Check the
                    bindings and the <strong>Permissions</strong> rules — Headlamp UI access
                    does not change this.
                  </>
                )}
              </Alert>
            ) : denied.length > 0 ? (
              <Alert severity="info" sx={{ mb: 2 }}>
                Headlamp will work. The greyed-out panels listed below stay empty at the
                current access level, which is often exactly what you want.
              </Alert>
            ) : (
              <Alert severity="success" sx={{ mb: 2 }}>
                Everything this plugin needs is allowed.
              </Alert>
            )}
            <Box>
              {results.map(r => (
                <ResultRow key={r.id} result={r} />
              ))}
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
