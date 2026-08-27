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
  LinearProgress,
  Stack,
  Typography,
} from '@mui/material';
import React, { useRef, useState } from 'react';
import { missingNamespaces, parseBundle, PortableAccount } from './lib/portable';

export type ImportOutcome = { name: string; ok: boolean; error?: string };

export default function ImportAccountsDialog({
  open,
  availableNamespaces,
  onClose,
  onImport,
}: {
  open: boolean;
  availableNamespaces: string[];
  onClose: () => void;
  onImport: (accounts: PortableAccount[]) => Promise<ImportOutcome[]>;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [accounts, setAccounts] = useState<PortableAccount[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<ImportOutcome[] | null>(null);

  function reset() {
    setAccounts(null);
    setErrors([]);
    setFileName('');
    setOutcomes(null);
  }

  async function handleFile(file: File) {
    reset();
    setFileName(file.name);
    const result = parseBundle(await file.text());
    setErrors(result.errors);
    setAccounts(result.bundle?.accounts ?? null);
  }

  async function runImport() {
    if (!accounts) return;
    setBusy(true);
    try {
      setOutcomes(await onImport(accounts));
    } finally {
      setBusy(false);
    }
  }

  const missing = accounts ? missingNamespaces(accounts, availableNamespaces) : [];

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : () => { reset(); onClose(); }}
      fullWidth
      maxWidth="sm"
    >
      <DialogTitle>Import accounts</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Recreates accounts from an exported file. Tokens are never part of the file — each
          account gets a fresh one on this cluster.
        </Typography>

        <input
          ref={fileRef}
          type="file"
          accept=".yaml,.yml,text/yaml"
          hidden
          onChange={e => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = '';
          }}
        />
        <Button
          variant="outlined"
          startIcon={<Icon icon="mdi:file-upload-outline" />}
          onClick={() => fileRef.current?.click()}
          disabled={busy}
        >
          Choose file
        </Button>
        {fileName && (
          <Typography variant="caption" sx={{ ml: 1 }}>
            {fileName}
          </Typography>
        )}

        {errors.length > 0 && (
          <Alert severity={accounts && accounts.length > 0 ? 'warning' : 'error'} sx={{ mt: 2 }}>
            <AlertTitle>
              {accounts && accounts.length > 0
                ? 'Some entries were skipped.'
                : 'Nothing could be read from this file.'}
            </AlertTitle>
            <Box component="ul" sx={{ m: 0, pl: 2 }}>
              {errors.map((e, i) => (
                <li key={i}>
                  <Typography variant="caption">{e}</Typography>
                </li>
              ))}
            </Box>
          </Alert>
        )}

        {missing.length > 0 && (
          <Alert severity="warning" sx={{ mt: 2 }}>
            <AlertTitle>Namespaces not on this cluster</AlertTitle>
            {missing.join(', ')} — those bindings will fail unless you create the namespaces
            first.
          </Alert>
        )}

        {accounts && accounts.length > 0 && !outcomes && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="subtitle2" gutterBottom>
              {accounts.length} account{accounts.length === 1 ? '' : 's'} to import
            </Typography>
            {accounts.map(a => (
              <Stack
                key={`${a.namespace}/${a.name}`}
                direction="row"
                spacing={1}
                alignItems="center"
                sx={{ py: 0.5 }}
              >
                <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                  {a.name}
                </Typography>
                <Chip size="small" label={a.scope === 'Cluster' ? 'cluster-wide' : `${a.namespaces.length} ns`} />
                <Chip size="small" variant="outlined" label={`UI: ${a.uiAccess}`} />
                <Chip size="small" variant="outlined" label={`${a.rules.length} rules`} />
              </Stack>
            ))}
            <Alert severity="info" sx={{ mt: 1 }}>
              An account that already exists here is overwritten with what the file says.
            </Alert>
          </Box>
        )}

        {busy && <LinearProgress sx={{ mt: 2 }} />}

        {outcomes && (
          <Box sx={{ mt: 2 }}>
            {outcomes.map(o => (
              <Stack key={o.name} direction="row" spacing={1} alignItems="flex-start" sx={{ py: 0.5 }}>
                <Icon
                  icon={o.ok ? 'mdi:check-circle' : 'mdi:close-circle'}
                  color={o.ok ? '#4caf50' : '#f44336'}
                  width={20}
                />
                <Box>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                    {o.name}
                  </Typography>
                  {o.error && (
                    <Typography variant="caption" color="error.main">
                      {o.error}
                    </Typography>
                  )}
                </Box>
              </Stack>
            ))}
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => { reset(); onClose(); }} disabled={busy}>
          {outcomes ? 'Close' : 'Cancel'}
        </Button>
        {!outcomes && (
          <Button
            variant="contained"
            disabled={!accounts || accounts.length === 0 || busy}
            onClick={runImport}
          >
            Import
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
