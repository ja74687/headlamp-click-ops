import { Icon } from '@iconify/react';
import { Box, Chip, Stack, Tooltip, Typography } from '@mui/material';
import React from 'react';
import { NginxProtection } from './lib/nginxAnnotations';
import { IngressHandling, isValidSourceRange, TriState, Verdict } from './lib/traefik';

const TRI_LABEL: Record<TriState, string> = { default: 'default', on: 'on', off: 'off' };

/** Which Traefik provider turns an Ingress into routes — or that none does. */
export function HandlingChip({
  handling,
  className,
}: {
  handling: IngressHandling;
  className: string | null;
}) {
  const cls = className ? `Class ${className}. ` : 'No class set. ';
  switch (handling.kind) {
    case 'native':
      return (
        <Tooltip
          title={`${cls}Served by Traefik's native Ingress provider, which reads traefik.ingress.kubernetes.io annotations.`}
        >
          <Chip size="small" variant="outlined" color="success" label="Traefik" />
        </Tooltip>
      );
    case 'nginx-compat':
      return (
        <Tooltip
          title={`${cls}Served by Traefik's ingress-nginx compatibility provider: it enforces nginx.ingress.kubernetes.io annotations and ignores traefik.ingress.kubernetes.io ones.`}
        >
          <Chip
            size="small"
            variant="outlined"
            color="info"
            label="Traefik · ingress-nginx compatibility"
          />
        </Tooltip>
      );
    case 'not-traefik':
      return (
        <Tooltip
          title={`${cls}${
            handling.controller
              ? `It belongs to controller ${handling.controller}.`
              : 'No Traefik provider takes it.'
          }`}
        >
          <Chip size="small" variant="outlined" label="Not served by Traefik" />
        </Tooltip>
      );
    case 'unknown':
      return (
        <Tooltip title={`${cls}${handling.reason}`}>
          <Chip size="small" variant="outlined" color="warning" label="Unknown" />
        </Tooltip>
      );
  }
}

/**
 * Middleware references from the Traefik annotation. Only with a "yes" verdict are they shown
 * as plain chips; otherwise they are marked so they never pass for active protection.
 */
export function TraefikRefs({
  refs,
  verdict,
  ignoredLabel = 'ignored',
}: {
  refs: string[];
  verdict: Verdict;
  ignoredLabel?: string;
}) {
  if (refs.length === 0) {
    return verdict.allowed === 'yes' ? (
      <Typography variant="caption" color="text.secondary">
        none
      </Typography>
    ) : null;
  }
  return (
    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
      {refs.map((r, i) => (
        <Chip
          key={`${r}/${i}`}
          size="small"
          variant="outlined"
          color={verdict.allowed === 'confirm' ? 'warning' : 'default'}
          label={r}
          sx={
            verdict.allowed === 'no' ? { textDecoration: 'line-through', opacity: 0.7 } : undefined
          }
        />
      ))}
      {verdict.allowed === 'no' && (
        <Tooltip title={verdict.reason}>
          <Chip size="small" color="error" variant="outlined" label={ignoredLabel} />
        </Tooltip>
      )}
      {verdict.allowed === 'confirm' && (
        <Tooltip title={verdict.reason}>
          <Chip size="small" color="warning" variant="outlined" label="unverified" />
        </Tooltip>
      )}
    </Stack>
  );
}

/** The per-route access-log switch, marked the same way as the references above. */
export function AccessLogCell({
  state,
  annotationPresent,
  verdict,
  globalOff,
  ignoredLabel = 'ignored',
}: {
  state: TriState;
  annotationPresent: boolean;
  verdict: Verdict;
  globalOff: boolean;
  ignoredLabel?: string;
}) {
  if (verdict.allowed === 'no') {
    if (!annotationPresent) {
      return (
        <Typography variant="caption" color="text.secondary">
          —
        </Typography>
      );
    }
    return (
      <Stack direction="row" spacing={0.5} alignItems="center">
        <Chip
          size="small"
          variant="outlined"
          label={TRI_LABEL[state]}
          sx={{ textDecoration: 'line-through', opacity: 0.7 }}
        />
        <Tooltip title={verdict.reason}>
          <Chip size="small" color="error" variant="outlined" label={ignoredLabel} />
        </Tooltip>
      </Stack>
    );
  }
  const chip = (
    <Chip
      size="small"
      variant={state === 'default' ? 'outlined' : 'filled'}
      color={verdict.allowed === 'confirm' ? 'warning' : state === 'on' ? 'success' : 'default'}
      label={TRI_LABEL[state]}
    />
  );
  const hint =
    verdict.allowed === 'confirm'
      ? verdict.reason
      : globalOff && state === 'on'
      ? "Traefik's global access log is off, so this switch has no effect."
      : '';
  return hint ? <Tooltip title={hint}>{chip}</Tooltip> : chip;
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 92 }}>
        {label}
      </Typography>
      {children}
    </Stack>
  );
}

const REDIRECT_LABEL: Record<NginxProtection['httpsRedirect'], string> = {
  forced: 'forced',
  on: 'on',
  off: 'off',
  'default-tls': 'on (default with TLS)',
  default: 'not set (default not documented)',
};

/**
 * What the ingress-nginx compatibility provider actually enforces on an Ingress. A missing
 * allowlist or password is shown in red: on such a row that is the real state, whatever
 * Traefik annotations it may also carry.
 */
export function NginxProtectionCell({
  protection,
  version,
}: {
  protection: NginxProtection;
  /** The running Traefik's version, for saying which one ignores the allowlist. */
  version: string | null;
}) {
  const { allowlist, allowlistEnforced, auth, authUrl, httpsRedirect, problems } = protection;
  const ignored = allowlistEnforced === 'no';
  return (
    <Stack spacing={0.5}>
      <Line label="IP allowlist">
        {allowlist && allowlist.length > 0 ? (
          <>
            {allowlist.map((r, i) => (
              <Chip
                key={`${r}/${i}`}
                size="small"
                variant="outlined"
                color={ignored || !isValidSourceRange(r) ? 'error' : 'default'}
                label={r}
                sx={ignored ? { textDecoration: 'line-through', opacity: 0.7 } : undefined}
              />
            ))}
            {ignored && (
              <Tooltip title="IP allowlist annotations only work from Traefik 3.7 on: every address gets through.">
                <Chip
                  size="small"
                  color="error"
                  label={version ? `ignored by Traefik ${version}` : 'ignored by this Traefik'}
                />
              </Tooltip>
            )}
            {allowlistEnforced === 'unknown' && (
              <Tooltip title="Traefik's version could not be read, and IP allowlist annotations only work from Traefik 3.7 on.">
                <Chip size="small" color="warning" variant="outlined" label="unverified" />
              </Tooltip>
            )}
          </>
        ) : (
          <Chip size="small" color="error" label="No IP allowlist" />
        )}
      </Line>
      <Line label="Password">
        {auth && (
          <Tooltip
            title={`auth-type ${auth.type}, secret type ${auth.secretType}${
              auth.realm ? `, realm "${auth.realm}"` : ''
            }`}
          >
            <Chip
              size="small"
              variant="outlined"
              label={`${auth.type} auth · secret ${auth.secret ?? '(missing)'}`}
            />
          </Tooltip>
        )}
        {authUrl && (
          <Tooltip title={authUrl}>
            <Chip size="small" variant="outlined" label="external auth" />
          </Tooltip>
        )}
        {!auth && !authUrl && <Chip size="small" color="error" label="No password" />}
      </Line>
      <Line label="HTTPS redirect">
        <Chip
          size="small"
          variant="outlined"
          color={httpsRedirect === 'off' ? 'warning' : 'default'}
          label={REDIRECT_LABEL[httpsRedirect]}
        />
      </Line>
      {problems.map((p, i) => (
        <Stack key={i} direction="row" spacing={0.5} alignItems="flex-start">
          <Box component="span" sx={{ color: 'warning.main', display: 'flex', pt: '2px' }}>
            <Icon icon="mdi:alert-outline" width={14} />
          </Box>
          <Typography variant="caption" color="warning.main">
            {p}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}
