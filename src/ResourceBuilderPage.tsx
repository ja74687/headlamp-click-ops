import { K8s } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Autocomplete, Box, Stack, Tab, Tabs, TextField, Typography } from '@mui/material';
import React, { useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import ConfigMapsTab from './ConfigMapsTab';
import SecretsTab from './SecretsTab';

const SET_NAMESPACE_FILTER = 'filter/setNamespaceFilter';

function useGlobalNamespaces(): string[] {
  const namespacesSet = useSelector(
    (state: { filter?: { namespaces?: Set<string> | string[] } }) => state?.filter?.namespaces,
  );
  return useMemo(() => {
    if (!namespacesSet) return [];
    if (namespacesSet instanceof Set) return [...namespacesSet];
    if (Array.isArray(namespacesSet)) return [...namespacesSet];
    return [];
  }, [namespacesSet]);
}

export default function ResourceBuilderPage() {
  const [tab, setTab] = useState<'configmaps' | 'secrets'>('configmaps');
  const activeNamespaces = useGlobalNamespaces();

  const dispatch = useDispatch();
  const [namespaces] = K8s.ResourceClasses.Namespace.useList();
  const namespaceOptions = (namespaces ?? []).map(n => n.metadata.name).sort();

  const setGlobalNamespaces = (next: string[]) =>
    dispatch({ type: SET_NAMESPACE_FILTER, payload: next });

  return (
    <SectionBox textAlign="left">
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'flex-start', md: 'flex-start' }}
        spacing={2}
        sx={{ mt: 1, mb: 3 }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h5" sx={{ mb: 0.5 }}>
            Resource Builder
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Click-build ConfigMaps and Secrets without writing YAML. The namespace picker is
            synced with Headlamp's global filter — pick here or from the topbar, both
            stay in sync.
          </Typography>
        </Box>
        <Autocomplete
          size="small"
          options={['', ...namespaceOptions]}
          getOptionLabel={o => (o === '' ? 'All namespaces' : o)}
          value={activeNamespaces[0] ?? ''}
          onChange={(_, v) => setGlobalNamespaces(v && v !== '' ? [v] : [])}
          renderInput={p => <TextField {...p} label="Namespace" />}
          sx={{ width: { xs: '100%', md: 320 }, flexShrink: 0 }}
        />
      </Stack>

      <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)}>
          <Tab value="configmaps" label="ConfigMaps" />
          <Tab value="secrets" label="Secrets" />
        </Tabs>
      </Box>

      {tab === 'configmaps' ? (
        <ConfigMapsTab activeNamespaces={activeNamespaces} />
      ) : (
        <SecretsTab activeNamespaces={activeNamespaces} />
      )}
    </SectionBox>
  );
}
