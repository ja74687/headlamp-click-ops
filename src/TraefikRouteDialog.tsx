import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  FormGroup,
  LinearProgress,
  Paper,
  Radio,
  RadioGroup,
  Stack,
  Typography,
} from '@mui/material';
import yaml from 'js-yaml';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  attachedIngressMiddlewares,
  attachedRouteMiddlewares,
  buildIngressPatch,
  editRoute,
  IngressClassInfo,
  ingressHandling,
  IngressObject,
  IngressRouteObject,
  ingressRouteVerdict,
  ingressVerdicts,
  parseAccessLogsAnnotation,
  routeAccessLogs,
  RouteEdit,
  ROUTER_ACCESSLOGS_ANNOTATION,
  ROUTER_MIDDLEWARES_ANNOTATION,
  saveIngress,
  saveIngressRoute,
  TraefikRuntime,
  TriState,
  Verdict,
} from './lib/traefik';
import YamlPreview from './YamlPreview';

export type Target =
  | { kind: 'Ingress'; obj: IngressObject }
  | { kind: 'IngressRoute'; obj: IngressRouteObject };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function MiddlewareChecks({
  known,
  selected,
  onChange,
  disabled,
}: {
  known: string[];
  selected: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  if (known.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No Middlewares in this namespace yet — build one on the Middlewares tab.
      </Typography>
    );
  }
  return (
    <FormGroup>
      {known.map(name => (
        <FormControlLabel
          key={name}
          disabled={disabled}
          control={
            <Checkbox
              size="small"
              checked={selected.includes(name)}
              onChange={e =>
                onChange(e.target.checked ? [...selected, name] : selected.filter(n => n !== name))
              }
            />
          }
          label={<Typography sx={{ fontFamily: 'monospace' }}>{name}</Typography>}
        />
      ))}
    </FormGroup>
  );
}

function AccessLogChoice({
  value,
  onChange,
  disabled,
}: {
  value: TriState;
  onChange: (v: TriState) => void;
  disabled: boolean;
}) {
  return (
    <RadioGroup row value={value} onChange={e => onChange(e.target.value as TriState)}>
      <FormControlLabel
        value="default"
        disabled={disabled}
        control={<Radio size="small" />}
        label="Traefik default"
      />
      <FormControlLabel
        value="on"
        disabled={disabled}
        control={<Radio size="small" />}
        label="On"
      />
      <FormControlLabel
        value="off"
        disabled={disabled}
        control={<Radio size="small" />}
        label="Off"
      />
    </RadioGroup>
  );
}

/** A section Traefik does not read: shown, but locked, with the reason. */
function Refusal({ verdict }: { verdict: Verdict }) {
  if (verdict.allowed !== 'no') return null;
  return (
    <Alert severity="error" sx={{ my: 1 }}>
      {verdict.reason}
    </Alert>
  );
}

export default function TraefikRouteDialog({
  target,
  knownFor,
  runtime,
  ingressClasses,
  onClose,
  onSaved,
}: {
  target: Target | null;
  knownFor: (namespace: string) => string[];
  runtime: TraefikRuntime;
  ingressClasses: IngressClassInfo[];
  onClose: () => void;
  onSaved: (notice: string | null) => Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [accessLogs, setAccessLogs] = useState<TriState>('default');
  const [routeEdits, setRouteEdits] = useState<RouteEdit[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const namespace = target?.obj.metadata.namespace ?? '';
  const known = useMemo(() => (target ? knownFor(namespace) : []), [target, namespace, knownFor]);

  // What the running Traefik reads decides what may be written: "no" locks a section,
  // "confirm" needs an explicit tick before Save.
  const verdicts = useMemo((): { middlewares: Verdict; accessLogs: Verdict } | null => {
    if (!target) return null;
    if (target.kind === 'Ingress') {
      return ingressVerdicts(ingressHandling(target.obj, ingressClasses, runtime), runtime);
    }
    const v = ingressRouteVerdict(runtime);
    return { middlewares: v, accessLogs: v };
  }, [target, ingressClasses, runtime]);
  const mwVerdict: Verdict = verdicts?.middlewares ?? { allowed: 'yes' };
  const alVerdict: Verdict = verdicts?.accessLogs ?? { allowed: 'yes' };
  const allNo = mwVerdict.allowed === 'no' && alVerdict.allowed === 'no';
  const confirmReasons = [
    ...new Set([mwVerdict, alVerdict].flatMap(v => (v.allowed === 'confirm' ? [v.reason] : []))),
  ];
  const sameRefusal =
    allNo &&
    mwVerdict.allowed === 'no' &&
    alVerdict.allowed === 'no' &&
    mwVerdict.reason === alVerdict.reason;

  // Initialise once per opened target. `known` gets a new identity on every data reload, and
  // re-running on that would wipe the ticks the user is in the middle of setting.
  const initialisedFor = useRef<Target | null>(null);
  useEffect(() => {
    if (target === initialisedFor.current) return;
    initialisedFor.current = target;
    setError(null);
    setConfirmed(false);
    if (!target) return;
    if (target.kind === 'Ingress') {
      const ann = target.obj.metadata.annotations ?? {};
      setSelected(attachedIngressMiddlewares(ann[ROUTER_MIDDLEWARES_ANNOTATION], namespace, known));
      setAccessLogs(parseAccessLogsAnnotation(ann[ROUTER_ACCESSLOGS_ANNOTATION]));
    } else {
      setRouteEdits(
        (target.obj.spec?.routes ?? []).map(r => ({
          selected: attachedRouteMiddlewares(r, namespace, known),
          accessLogs: routeAccessLogs(r),
        }))
      );
    }
  }, [target, namespace, known]);

  const change = useMemo(() => {
    if (!target) return null;
    if (target.kind === 'Ingress') {
      // A locked section is left out of the patch, so its annotation stays exactly as it is.
      return buildIngressPatch(target.obj, known, selected, accessLogs, {
        middlewares: mwVerdict.allowed !== 'no',
        accessLogs: alVerdict.allowed !== 'no',
      });
    }
    const routes = (target.obj.spec?.routes ?? []).map((r, i) =>
      editRoute(r, namespace, known, routeEdits[i] ?? { selected: [], accessLogs: 'default' })
    );
    return { spec: { routes } };
  }, [
    target,
    known,
    selected,
    accessLogs,
    routeEdits,
    namespace,
    mwVerdict.allowed,
    alVerdict.allowed,
  ]);

  const canSave = !allNo && !busy && change !== null && (confirmReasons.length === 0 || confirmed);

  async function save() {
    if (!target || !change || !canSave) return;
    setBusy(true);
    setError(null);
    try {
      let notice: string | null = null;
      if (target.kind === 'Ingress') {
        await saveIngress(target.obj, change);
      } else {
        const result = await saveIngressRoute(target.obj, (change as any).spec.routes);
        if (result.observabilityPruned) {
          notice =
            `Middlewares on ${namespace}/${target.obj.metadata.name} were saved, but the API server ` +
            'dropped the access-log setting: the installed Traefik CRDs do not know ' +
            'routes[].observability yet. Upgrade Traefik and its CRDs to use per-route access logs.';
        }
      }
      await onSaved(notice);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  const accessLogNote = (
    <Typography variant="caption" color="text.secondary" component="div">
      A per-route switch only takes effect when access logging is enabled in Traefik's static
      configuration (Helm values), which this page cannot change.
    </Typography>
  );

  return (
    <Dialog open={target !== null} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        {target?.kind} {namespace}/{target?.obj.metadata.name}
      </DialogTitle>
      <DialogContent dividers>
        {sameRefusal && <Refusal verdict={mwVerdict} />}

        {confirmReasons.length > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {confirmReasons.map(r => (
              <div key={r}>{r}</div>
            ))}
            <FormControlLabel
              sx={{ mt: 1 }}
              control={
                <Checkbox
                  size="small"
                  checked={confirmed}
                  onChange={e => setConfirmed(e.target.checked)}
                />
              }
              label="I've checked that Traefik reads this — save anyway"
            />
          </Alert>
        )}

        <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 2 }}>
          Only Middlewares from this namespace are offered: using one from another namespace needs{' '}
          <code>allowCrossNamespace</code> in Traefik's configuration. References that are already
          there to other namespaces or providers stay untouched. Newly ticked middlewares run after
          the ones already attached.
        </Typography>

        {target?.kind === 'Ingress' && (
          <Stack spacing={2}>
            <Box>
              <Typography variant="subtitle2">Middlewares</Typography>
              {!sameRefusal && <Refusal verdict={mwVerdict} />}
              <MiddlewareChecks
                known={known}
                selected={selected}
                onChange={setSelected}
                disabled={mwVerdict.allowed === 'no'}
              />
            </Box>
            <Box>
              <Typography variant="subtitle2">Access logs</Typography>
              {!sameRefusal && <Refusal verdict={alVerdict} />}
              <AccessLogChoice
                value={accessLogs}
                onChange={setAccessLogs}
                disabled={alVerdict.allowed === 'no'}
              />
              {accessLogNote}
            </Box>
          </Stack>
        )}

        {target?.kind === 'IngressRoute' && (
          <Stack spacing={2}>
            {(target.obj.spec?.routes ?? []).length === 0 && (
              <Typography variant="body2" color="text.secondary">
                This IngressRoute has no routes.
              </Typography>
            )}
            {(target.obj.spec?.routes ?? []).map((route, i) => {
              const edit = routeEdits[i] ?? { selected: [], accessLogs: 'default' as TriState };
              const update = (patch: Partial<RouteEdit>) =>
                setRouteEdits(prev => prev.map((e, j) => (j === i ? { ...e, ...patch } : e)));
              return (
                <Paper key={i} variant="outlined" sx={{ p: 1.5 }}>
                  <Typography variant="body2" sx={{ fontFamily: 'monospace', mb: 1 }}>
                    {route.match || `route ${i + 1}`}
                  </Typography>
                  <Typography variant="subtitle2">Middlewares</Typography>
                  <MiddlewareChecks
                    known={known}
                    selected={edit.selected}
                    onChange={next => update({ selected: next })}
                    disabled={mwVerdict.allowed === 'no'}
                  />
                  <Typography variant="subtitle2" sx={{ mt: 1 }}>
                    Access logs
                  </Typography>
                  <AccessLogChoice
                    value={edit.accessLogs}
                    onChange={v => update({ accessLogs: v })}
                    disabled={alVerdict.allowed === 'no'}
                  />
                </Paper>
              );
            })}
            {accessLogNote}
          </Stack>
        )}

        {!allNo && (
          <Box sx={{ mt: 2 }}>
            <YamlPreview
              title="Change to apply"
              yaml={change ? yaml.dump(change, { noRefs: true, lineWidth: -1 }) : ''}
              maxHeight={220}
            />
          </Box>
        )}

        {error && (
          <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {busy && <LinearProgress sx={{ mt: 2 }} />}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          {allNo ? 'Close' : 'Cancel'}
        </Button>
        {!allNo && (
          <Button variant="contained" onClick={save} disabled={!canSave}>
            Save
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
