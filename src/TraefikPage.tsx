import { K8s } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import {
  Alert,
  AlertTitle,
  Autocomplete,
  Box,
  Chip,
  CircularProgress,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  detectTraefik,
  detectTraefikRuntime,
  loadTraefikData,
  ProviderState,
  TraefikData,
  TraefikDetection,
  TraefikRuntime,
} from './lib/traefik';
import TraefikMiddlewaresTab from './TraefikMiddlewaresTab';
import TraefikRoutesTab from './TraefikRoutesTab';
import { useGlobalNamespaces, useSetGlobalNamespaces } from './useNamespaceFilter';

function ProviderChip({
  label,
  state,
  hint,
}: {
  label: string;
  state: ProviderState;
  hint: string;
}) {
  return (
    <Tooltip title={hint}>
      <Chip
        size="small"
        variant="outlined"
        color={state === 'on' ? 'success' : state === 'unknown' ? 'warning' : 'default'}
        label={`${label}: ${state}`}
      />
    </Tooltip>
  );
}

/**
 * Which providers the running Traefik has switched on. A Middleware or an annotation only
 * protects anything when the provider that reads it is on, so this is shown before any list.
 */
function RuntimeStrip({ runtime }: { runtime: TraefikRuntime }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={1}
        alignItems={{ xs: 'flex-start', md: 'center' }}
        flexWrap="wrap"
        useFlexGap
      >
        <Typography variant="subtitle2">How Traefik runs here</Typography>
        {runtime.status === 'known' && (
          <>
            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
              {runtime.source} · {runtime.image}
            </Typography>
            {runtime.version ? (
              <Chip
                size="small"
                variant="outlined"
                label={`Traefik ${runtime.version.major}.${runtime.version.minor}.${runtime.version.patch}`}
              />
            ) : (
              <Tooltip title="The image tag does not name a release (latest, a digest, or a custom build), so version-dependent behaviour is treated as unknown.">
                <Chip size="small" variant="outlined" color="warning" label="version unknown" />
              </Tooltip>
            )}
            <ProviderChip
              label="CRD provider"
              state={runtime.providers.kubernetesCRD}
              hint="kubernetesCRD: reads Middleware and IngressRoute objects."
            />
            <ProviderChip
              label="Ingress provider"
              state={runtime.providers.kubernetesIngress}
              hint="kubernetesIngress: reads Ingresses of Traefik's own class, including the traefik.ingress.kubernetes.io annotations."
            />
            <ProviderChip
              label="ingress-nginx compatibility"
              state={runtime.providers.kubernetesIngressNGINX}
              hint={`kubernetesIngressNGINX: reads Ingresses of ingress-nginx classes and enforces their nginx.ingress.kubernetes.io annotations; it ignores traefik.ingress.kubernetes.io ones. ingressClass ${
                runtime.nginx.ingressClass
              }${runtime.nginx.ingressClassByName ? ' (matched by name)' : ''}, ${
                runtime.nginx.watchIngressWithoutClass
                  ? 'also takes Ingresses without a class'
                  : 'ignores Ingresses without a class'
              }.`}
            />
            {runtime.providers.kubernetesIngressNGINX === 'on' && (
              <Typography variant="caption" color="text.secondary">
                controllerClass <code>{runtime.nginx.controllerClass}</code>
              </Typography>
            )}
            <ProviderChip
              label="Access logs"
              state={runtime.accessLogs}
              hint="Traefik's global access log. Per-route switches only matter when it is on."
            />
          </>
        )}
      </Stack>
      {runtime.status === 'unknown' && (
        <Alert severity="warning" sx={{ mt: 1 }}>
          How this Traefik is configured could not be read: {runtime.reason} Every change on this
          page asks you to confirm that Traefik actually reads it.
        </Alert>
      )}
    </Paper>
  );
}

export default function TraefikPage() {
  const [tab, setTab] = useState<'middlewares' | 'routes'>('middlewares');
  const activeNamespaces = useGlobalNamespaces();
  const setGlobalNamespaces = useSetGlobalNamespaces();
  const [namespaces] = K8s.ResourceClasses.Namespace.useList();
  const namespaceOptions = (namespaces ?? []).map(n => n.metadata.name).sort();

  const [detection, setDetection] = useState<TraefikDetection | null>(null);
  const [runtime, setRuntime] = useState<TraefikRuntime | null>(null);
  const [data, setData] = useState<TraefikData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([detectTraefik(), detectTraefikRuntime()]).then(([d, r]) => {
      if (cancelled) return;
      setDetection(d);
      setRuntime(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const crdsServed = detection?.available === true;
  // Without traefik.io the page is still worth showing when Traefik serves Ingresses through
  // the ingress-nginx compatibility provider: their real protection is visible there.
  const compatOnly =
    !crdsServed && runtime?.status === 'known' && runtime.providers.kubernetesIngressNGINX === 'on';
  const usable = crdsServed || compatOnly;
  const shownTab = compatOnly ? 'routes' : tab;

  // Switching namespaces quickly must not let a slow, older response overwrite a newer one.
  const latestLoad = useRef(0);
  const load = useCallback(async () => {
    const id = ++latestLoad.current;
    setLoading(true);
    try {
      const [next, rt] = await Promise.all([
        loadTraefikData(activeNamespaces, { crds: crdsServed }),
        detectTraefikRuntime(),
      ]);
      if (id === latestLoad.current) {
        setData(next);
        setRuntime(rt);
      }
    } finally {
      if (id === latestLoad.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNamespaces.join(','), crdsServed]);

  useEffect(() => {
    if (usable) load();
  }, [usable, load]);

  return (
    <SectionBox textAlign="left">
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        justifyContent="space-between"
        alignItems="flex-start"
        spacing={2}
        sx={{ mt: 1, mb: 3 }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h5" sx={{ mb: 0.5 }}>
            Traefik
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Build Traefik middlewares — IP allowlist, login, HTTPS redirect, security headers, rate
            limits — from a form, then switch them on for your Ingresses and IngressRoutes with a
            checkbox. The namespace picker is synced with Headlamp's global filter.
          </Typography>
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
            Built for Traefik v3. Traefik v2.10 and 2.11 serve the same traefik.io API, but their
            CRDs lack v3 fields such as <code>ipAllowList</code> and per-route access logs — the
            page warns when a save loses fields that way.
          </Typography>
        </Box>
        <Autocomplete
          size="small"
          options={['', ...namespaceOptions]}
          getOptionLabel={o => (o === '' ? 'All namespaces' : o)}
          value={activeNamespaces[0] ?? ''}
          onChange={(_, v) => setGlobalNamespaces(v ? [v] : [])}
          renderInput={p => <TextField {...p} label="Namespace" />}
          sx={{ width: { xs: '100%', md: 320 }, flexShrink: 0 }}
        />
      </Stack>

      {detection === null || runtime === null ? (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 2 }}>
          <CircularProgress size={18} />
          <Typography variant="body2">Looking for Traefik…</Typography>
        </Stack>
      ) : !usable ? (
        <Alert severity="info">
          <AlertTitle>Traefik v3 CRDs not found in this cluster.</AlertTitle>
          {detection.v2Detected
            ? 'This cluster serves the Traefik v2 API (traefik.containo.us). This page supports Traefik v3 (traefik.io/v1alpha1) only — upgrade Traefik and its CRDs to use it.'
            : 'This page needs Traefik v3 with its CRDs installed (API group traefik.io/v1alpha1). k3s ships it by default; elsewhere install it with the official Helm chart. Traefik v2.10/2.11 serve traefik.io as well, but this page targets the v3 CRDs.'}
          {detection.error && (
            <Typography variant="caption" component="div" sx={{ mt: 1 }}>
              {detection.error}
            </Typography>
          )}
        </Alert>
      ) : (
        <>
          <RuntimeStrip runtime={runtime} />

          {compatOnly && (
            <Alert severity="info" sx={{ mb: 2 }}>
              This cluster does not serve the Traefik CRDs (traefik.io/v1alpha1), and Traefik serves
              Ingresses through its ingress-nginx compatibility provider. Middlewares and
              IngressRoutes do not exist here, so only the Ingresses and the protection their
              nginx.ingress.kubernetes.io annotations give them are shown.
            </Alert>
          )}

          <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
            <Tabs value={shownTab} onChange={(_, v) => setTab(v)}>
              {!compatOnly && <Tab value="middlewares" label="Middlewares" />}
              <Tab value="routes" label="Routes" />
            </Tabs>
          </Box>

          {data?.errors.map((e, i) => (
            <Alert severity="warning" sx={{ mb: 1 }} key={i}>
              {e}
            </Alert>
          ))}

          {data === null ? (
            <Stack alignItems="center" sx={{ py: 3 }}>
              <CircularProgress size={24} />
            </Stack>
          ) : shownTab === 'middlewares' ? (
            <TraefikMiddlewaresTab
              data={data}
              runtime={runtime}
              loading={loading}
              activeNamespaces={activeNamespaces}
              namespaceOptions={namespaceOptions}
              onChanged={load}
            />
          ) : (
            <TraefikRoutesTab
              data={data}
              runtime={runtime}
              crdsServed={crdsServed}
              loading={loading}
              onChanged={load}
            />
          )}
        </>
      )}
    </SectionBox>
  );
}
