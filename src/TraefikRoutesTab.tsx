import { Icon } from '@iconify/react';
import {
  Alert,
  Box,
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
import React, { useMemo, useState } from 'react';
import { compatSemantics, nginxProtection } from './lib/nginxAnnotations';
import {
  describeIngressRefs,
  describeRouteRefs,
  IngressHandling,
  ingressHandling,
  ingressHosts,
  IngressObject,
  ingressRouteVerdict,
  ingressVerdicts,
  LEGACY_CLASS_ANNOTATION,
  parseAccessLogsAnnotation,
  routeAccessLogs,
  ROUTER_ACCESSLOGS_ANNOTATION,
  ROUTER_MIDDLEWARES_ANNOTATION,
  TraefikData,
  TraefikRuntime,
  Verdict,
} from './lib/traefik';
import NginxProtectionDialog, { NginxTarget } from './NginxProtectionDialog';
import {
  AccessLogCell,
  HandlingChip,
  NginxProtectionCell,
  TraefikRefs,
} from './TraefikIngressCells';
import TraefikRouteDialog, { Target } from './TraefikRouteDialog';

function explicitClass(ing: IngressObject): string | null {
  return ing.spec?.ingressClassName ?? ing.metadata.annotations?.[LEGACY_CLASS_ANNOTATION] ?? null;
}

export default function TraefikRoutesTab({
  data,
  runtime,
  crdsServed,
  loading,
  onChanged,
}: {
  data: TraefikData;
  runtime: TraefikRuntime;
  /** traefik.io is served; without it there are no Middlewares or IngressRoutes to show. */
  crdsServed: boolean;
  loading: boolean;
  onChanged: () => Promise<void>;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const [nginxTarget, setNginxTarget] = useState<NginxTarget | null>(null);
  const [notice, setNotice] = useState<{ severity: 'success' | 'warning'; text: string } | null>(
    null
  );

  const knownByNamespace = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const m of data.middlewares) {
      const list = map.get(m.metadata.namespace) ?? [];
      list.push(m.metadata.name);
      map.set(m.metadata.namespace, list);
    }
    return map;
  }, [data.middlewares]);
  const knownFor = useMemo(
    () => (namespace: string) => knownByNamespace.get(namespace) ?? [],
    [knownByNamespace]
  );

  const globalAccessLogsOff = runtime.status === 'known' && runtime.accessLogs === 'off';
  const routeVerdict = ingressRouteVerdict(runtime);
  const semantics = compatSemantics(runtime);

  async function handleSaved(next: string | null) {
    setTarget(null);
    setNotice(next ? { severity: 'warning', text: next } : null);
    await onChanged();
  }

  async function handleNginxSaved(text: string) {
    setNginxTarget(null);
    setNotice({ severity: 'success', text });
    await onChanged();
  }

  /** Disabled, with the reason as tooltip, when Traefik reads nothing the dialog could write. */
  const editButton = (
    t: Target,
    verdicts: Verdict[],
    hint = 'Choose middlewares and access logs'
  ) => {
    const blocked = verdicts.find(v => v.allowed === 'no');
    const allNo = verdicts.every(v => v.allowed === 'no');
    return (
      <Tooltip title={allNo && blocked?.allowed === 'no' ? blocked.reason : hint}>
        <span>
          <IconButton
            size="small"
            onClick={() => setTarget(t)}
            disabled={allNo}
            aria-label="Edit route middlewares"
          >
            <Icon icon="mdi:pencil-outline" />
          </IconButton>
        </span>
      </Tooltip>
    );
  };

  const nginxButton = (ingress: IngressObject, handling: IngressHandling, hint: string) => (
    <Tooltip title={hint}>
      <IconButton
        size="small"
        onClick={() => setNginxTarget({ ingress, handling })}
        aria-label="Edit nginx protection"
      >
        <Icon icon="mdi:shield-edit-outline" />
      </IconButton>
    </Tooltip>
  );

  /**
   * Native rows get the middleware dialog, compatibility rows the nginx one. When it is not
   * known which provider serves the row, both are offered and each asks for confirmation.
   */
  const ingressActions = (
    ing: IngressObject,
    handling: IngressHandling,
    verdicts: { middlewares: Verdict; accessLogs: Verdict }
  ) => {
    const traefik = { kind: 'Ingress' as const, obj: ing };
    switch (handling.kind) {
      case 'nginx-compat':
        return nginxButton(ing, handling, 'Edit IP allowlist, password and HTTPS redirect');
      case 'unknown':
        return (
          <Stack direction="row" spacing={0.5} justifyContent="flex-end">
            {editButton(
              traefik,
              [verdicts.middlewares, verdicts.accessLogs],
              "Attach Traefik middlewares — only has an effect if Traefik's native Ingress provider serves this Ingress"
            )}
            {nginxButton(
              ing,
              handling,
              "Edit the nginx.ingress.kubernetes.io IP allowlist, password and HTTPS redirect — only has an effect if Traefik's ingress-nginx compatibility provider serves this Ingress"
            )}
          </Stack>
        );
      default:
        return editButton(traefik, [verdicts.middlewares, verdicts.accessLogs]);
    }
  };

  return (
    <Stack spacing={3}>
      {notice && (
        <Alert severity={notice.severity} onClose={() => setNotice(null)}>
          {notice.text}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Box>
            <Typography variant="h6">Ingresses</Typography>
            <Typography variant="body2" color="text.secondary">
              Standard Kubernetes Ingresses. Traefik's own Ingress provider attaches middlewares
              with the <code>{ROUTER_MIDDLEWARES_ANNOTATION}</code> annotation; its ingress-nginx
              compatibility provider ignores that and enforces the{' '}
              <code>nginx.ingress.kubernetes.io</code> annotations instead.
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} alignItems="center">
            {loading && <CircularProgress size={18} />}
            <Tooltip title="Refresh">
              <IconButton onClick={onChanged} size="small" aria-label="Refresh">
                <Icon icon="mdi:refresh" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
        {data.ingresses.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
            No Ingresses in the selected namespaces.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Hosts</TableCell>
                <TableCell>Protection</TableCell>
                <TableCell>Access logs</TableCell>
                <TableCell align="right">Edit</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.ingresses.map(ing => {
                const ns = ing.metadata.namespace;
                const handling = ingressHandling(ing, data.ingressClasses, runtime);
                const verdicts = ingressVerdicts(handling, runtime);
                const compat = handling.kind === 'nginx-compat';
                const ignoredLabel = compat ? 'ignored by this provider' : 'ignored';
                const annotations = ing.metadata.annotations ?? {};
                return (
                  <TableRow hover key={`${ns}/${ing.metadata.name}`}>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                        {ing.metadata.name}
                      </Typography>
                      <Stack
                        direction="row"
                        spacing={0.5}
                        sx={{ mt: 0.5 }}
                        flexWrap="wrap"
                        useFlexGap
                      >
                        <Chip size="small" label={ns} />
                        <HandlingChip handling={handling} className={explicitClass(ing)} />
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                        {ingressHosts(ing).join(', ') || '*'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Stack spacing={1}>
                        {compat && (
                          <NginxProtectionCell
                            protection={nginxProtection(ing, semantics)}
                            version={semantics.version}
                          />
                        )}
                        <TraefikRefs
                          refs={describeIngressRefs(ing, knownFor(ns))}
                          verdict={verdicts.middlewares}
                          ignoredLabel={ignoredLabel}
                        />
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <AccessLogCell
                        state={parseAccessLogsAnnotation(annotations[ROUTER_ACCESSLOGS_ANNOTATION])}
                        annotationPresent={ROUTER_ACCESSLOGS_ANNOTATION in annotations}
                        verdict={verdicts.accessLogs}
                        globalOff={globalAccessLogsOff}
                        ignoredLabel={ignoredLabel}
                      />
                    </TableCell>
                    <TableCell align="right">{ingressActions(ing, handling, verdicts)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Paper>

      {crdsServed && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="h6">IngressRoutes</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Traefik's own routing objects. Middlewares and access logs are set per route.
          </Typography>
          {routeVerdict.allowed === 'no' && (
            <Alert severity="error" sx={{ mb: 1 }}>
              {routeVerdict.reason} The IngressRoutes below route no traffic, and nothing set on
              them protects anything.
            </Alert>
          )}
          {data.ingressRoutes.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
              No IngressRoutes in the selected namespaces.
            </Typography>
          ) : (
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Routes</TableCell>
                  <TableCell align="right">Edit</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.ingressRoutes.map(ir => {
                  const ns = ir.metadata.namespace;
                  const routes = ir.spec?.routes ?? [];
                  return (
                    <TableRow hover key={`${ns}/${ir.metadata.name}`}>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                          {ir.metadata.name}
                        </Typography>
                        <Stack
                          direction="row"
                          spacing={0.5}
                          sx={{ mt: 0.5 }}
                          flexWrap="wrap"
                          useFlexGap
                        >
                          <Chip size="small" label={ns} />
                          {(ir.spec?.entryPoints ?? []).map(ep => (
                            <Chip key={ep} size="small" variant="outlined" label={ep} />
                          ))}
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Stack spacing={1}>
                          {routes.map((r, i) => (
                            <Box key={i}>
                              <Typography
                                variant="caption"
                                sx={{ fontFamily: 'monospace', display: 'block' }}
                              >
                                {r.match || `route ${i + 1}`}
                              </Typography>
                              <Stack
                                direction="row"
                                spacing={1}
                                alignItems="center"
                                flexWrap="wrap"
                                useFlexGap
                              >
                                <TraefikRefs
                                  refs={describeRouteRefs(r, ns)}
                                  verdict={routeVerdict}
                                />
                                <Typography variant="caption" color="text.secondary">
                                  logs
                                </Typography>
                                <AccessLogCell
                                  state={routeAccessLogs(r)}
                                  annotationPresent={
                                    typeof r.observability?.accessLogs === 'boolean'
                                  }
                                  verdict={routeVerdict}
                                  globalOff={globalAccessLogsOff}
                                />
                              </Stack>
                            </Box>
                          ))}
                        </Stack>
                      </TableCell>
                      <TableCell align="right">
                        {editButton({ kind: 'IngressRoute', obj: ir }, [routeVerdict])}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Paper>
      )}

      <TraefikRouteDialog
        target={target}
        knownFor={knownFor}
        runtime={runtime}
        ingressClasses={data.ingressClasses}
        onClose={() => setTarget(null)}
        onSaved={handleSaved}
      />
      <NginxProtectionDialog
        target={nginxTarget}
        runtime={runtime}
        ingresses={data.ingresses}
        onClose={() => setNginxTarget(null)}
        onSaved={handleNginxSaved}
      />
    </Stack>
  );
}
