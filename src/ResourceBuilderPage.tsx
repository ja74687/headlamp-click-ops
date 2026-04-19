import { K8s } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import { Autocomplete, Box, Stack, Tab, Tabs, TextField, Typography } from '@mui/material';
import React, { useState } from 'react';
import ConfigMapsTab from './ConfigMapsTab';
import SecretsTab from './SecretsTab';

export default function ResourceBuilderPage() {
  const [tab, setTab] = useState<'configmaps' | 'secrets'>('configmaps');
  const [namespaces] = K8s.ResourceClasses.Namespace.useList();
  const namespaceOptions = (namespaces ?? []).map(n => n.metadata.name).sort();

  const [activeNamespace, setActiveNamespace] = useState<string>('');

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
            Click-build ConfigMaps and Secrets without writing YAML. Create, edit and delete them
            across any namespace. The picker on the right filters both lists and pre-selects that
            namespace when creating a new resource.
          </Typography>
        </Box>
        <Autocomplete
          size="small"
          options={['', ...namespaceOptions]}
          getOptionLabel={o => (o === '' ? 'All namespaces' : o)}
          value={activeNamespace}
          onChange={(_, v) => setActiveNamespace(v ?? '')}
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
        <ConfigMapsTab activeNamespace={activeNamespace} />
      ) : (
        <SecretsTab activeNamespace={activeNamespace} />
      )}
    </SectionBox>
  );
}
