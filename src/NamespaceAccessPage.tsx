import { Icon } from '@iconify/react';
import { K8s } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import {
  Alert,
  Autocomplete,
  Box,
  Chip,
  CircularProgress,
  FormControlLabel,
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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  describeSubject,
  fetchNamespaceAccess,
  Grant,
  isFullAccess,
  isWriteCapable,
  NamespaceAccessReport,
  summariseRules,
} from './lib/namespaceAccess';

function GrantRow({ grant }: { grant: Grant }) {
  const full = isFullAccess(grant.rules);
  const write = isWriteCapable(grant.rules);
  return (
    <TableRow hover>
      <TableCell>
        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
          {grant.bindingName}
        </Typography>
        <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }} flexWrap="wrap" useFlexGap>
          <Chip
            size="small"
            label={grant.source === 'ClusterRoleBinding' ? 'cluster-wide' : 'namespaced'}
            color={grant.source === 'ClusterRoleBinding' ? 'warning' : 'default'}
            variant="outlined"
          />
          {grant.managed && <Chip size="small" label="click-ops" variant="outlined" />}
          {grant.uiHelper && <Chip size="small" label="UI helper" variant="outlined" />}
        </Stack>
      </TableCell>
      <TableCell>
        <Stack spacing={0.25}>
          {grant.subjects.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              no subjects
            </Typography>
          ) : (
            grant.subjects.map((s, i) => (
              <Typography key={i} variant="body2" sx={{ fontFamily: 'monospace' }}>
                {describeSubject(s)}
              </Typography>
            ))
          )}
        </Stack>
      </TableCell>
      <TableCell>
        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
          {grant.roleKind}/{grant.roleName}
        </Typography>
      </TableCell>
      <TableCell>
        {grant.rulesUnavailable ? (
          <Tooltip title="The role itself could not be read, so its rules are unknown.">
            <Typography variant="body2" color="text.secondary">
              unreadable
            </Typography>
          </Tooltip>
        ) : (
          <Stack direction="row" spacing={0.5} alignItems="center">
            {full && <Icon icon="mdi:alert" color="#ed6c02" width={18} />}
            <Typography variant="body2" color={write ? 'text.primary' : 'text.secondary'}>
              {summariseRules(grant.rules)}
            </Typography>
          </Stack>
        )}
      </TableCell>
    </TableRow>
  );
}

export default function NamespaceAccessPage() {
  const [namespaces] = K8s.ResourceClasses.Namespace.useList();
  const namespaceOptions = useMemo(
    () => (namespaces ?? []).map(n => n.metadata.name).sort(),
    [namespaces],
  );

  const [namespace, setNamespace] = useState<string>('');
  const [report, setReport] = useState<NamespaceAccessReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [hideClusterWide, setHideClusterWide] = useState(false);
  const [hideUiHelpers, setHideUiHelpers] = useState(true);

  useEffect(() => {
    if (!namespace && namespaceOptions.length > 0) {
      setNamespace(namespaceOptions.includes('default') ? 'default' : namespaceOptions[0]);
    }
  }, [namespaceOptions, namespace]);

  // Switching namespaces quickly could let a slower, older answer land last and show the
  // wrong namespace's grants; only the latest request may write.
  const latest = useRef(0);
  const load = useCallback(async (ns: string) => {
    if (!ns) return;
    const id = ++latest.current;
    setLoading(true);
    try {
      const next = await fetchNamespaceAccess(ns);
      if (id === latest.current) setReport(next);
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(namespace);
  }, [namespace, load]);

  const grants = report?.grants ?? [];
  const visible = grants
    .filter(g => (hideClusterWide ? g.source !== 'ClusterRoleBinding' : true))
    .filter(g => (hideUiHelpers ? !g.uiHelper : true));

  const subjectCount = new Set(
    visible.flatMap(g => g.subjects.map(describeSubject)),
  ).size;
  const writeCount = visible.filter(g => isWriteCapable(g.rules)).length;
  const fullCount = visible.filter(g => isFullAccess(g.rules)).length;

  return (
    <SectionBox textAlign="left">
      <Box sx={{ mt: 3, mb: 3 }}>
        <Typography variant="h5" sx={{ mb: 0.5 }}>
          Namespace Access
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Everything that grants access to one namespace, whoever created it. RoleBindings in
          the namespace plus every ClusterRoleBinding, because a ClusterRoleBinding reaches
          into every namespace at once — that is usually the grant people forget about.
        </Typography>
      </Box>

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="flex-start">
          <Autocomplete
            options={namespaceOptions}
            value={namespace || null}
            onChange={(_, v) => setNamespace(v ?? '')}
            renderInput={p => <TextField {...p} label="Namespace" size="small" />}
            sx={{ width: { xs: '100%', md: 320 } }}
          />
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={hideClusterWide}
                onChange={e => setHideClusterWide(e.target.checked)}
              />
            }
            label="Hide cluster-wide"
          />
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={hideUiHelpers}
                onChange={e => setHideUiHelpers(e.target.checked)}
              />
            }
            label="Hide UI helpers"
          />
        </Stack>
      </Paper>

      {report?.errors.map((e, i) => (
        <Alert severity="warning" sx={{ mb: 1 }} key={i}>
          {e}
        </Alert>
      ))}

      {loading ? (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ p: 2 }}>
          <CircularProgress size={18} />
          <Typography variant="body2">Reading bindings…</Typography>
        </Stack>
      ) : (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
            <Chip size="small" label={`${visible.length} grants`} />
            <Chip size="small" label={`${subjectCount} distinct subjects`} />
            <Chip
              size="small"
              label={`${writeCount} can write`}
              color={writeCount > 0 ? 'warning' : 'default'}
            />
            {fullCount > 0 && (
              <Chip size="small" color="error" label={`${fullCount} with full access`} />
            )}
          </Stack>

          {visible.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              Nothing grants access to this namespace with the current filters.
            </Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Binding</TableCell>
                  <TableCell>Subjects</TableCell>
                  <TableCell>Role</TableCell>
                  <TableCell>Grants</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {visible.map(g => (
                  <GrantRow key={g.id} grant={g} />
                ))}
              </TableBody>
            </Table>
          )}
        </Paper>
      )}
    </SectionBox>
  );
}
