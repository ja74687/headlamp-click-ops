import { Icon } from '@iconify/react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import React, { useState } from 'react';
import KeyValueEditor from './KeyValueEditor';
import {
  basicAuthSecretName,
  HSTS_OPTIONS,
  isValidSourceRange,
  LOCALHOST_RANGES,
  MiddlewareForm,
  PRIVATE_RANGES,
  RATE_PERIODS,
  REFERRER_POLICIES,
} from './lib/traefik';

type FieldsProps = {
  form: MiddlewareForm;
  onChange: (next: MiddlewareForm) => void;
  creating: boolean;
};

/** Typed values may arrive pasted as "a, b c"; each piece becomes its own entry. */
export function splitEntries(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    for (const piece of v.split(/[\s,]+/)) {
      if (piece && !out.includes(piece)) out.push(piece);
    }
  }
  return out;
}

export function ListInput({
  label,
  values,
  onChange,
  options = [],
  isValid,
  helperText,
  placeholder,
  disabled = false,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  options?: string[];
  isValid?: (v: string) => boolean;
  helperText: string;
  placeholder: string;
  disabled?: boolean;
}) {
  const [input, setInput] = useState('');

  // Typed text would be lost on blur unless Enter was pressed, so blur commits it — and only
  // it. MUI's autoSelect also commits the highlighted option, which on an allowlist means
  // hovering a suggestion and clicking away silently lets a whole network in.
  function commitTyped() {
    const typed = input.trim();
    setInput('');
    if (typed) onChange(splitEntries([...values, typed]));
  }

  return (
    <Autocomplete
      multiple
      freeSolo
      disabled={disabled}
      options={options}
      value={values}
      inputValue={input}
      onInputChange={(_, v) => setInput(v)}
      onChange={(_, v) => onChange(splitEntries(v as string[]))}
      renderTags={(value, getTagProps) =>
        value.map((v, index) => {
          const { key, ...tagProps } = getTagProps({ index });
          return (
            <Chip
              key={key}
              size="small"
              label={v}
              color={isValid && !isValid(v) ? 'error' : 'default'}
              {...tagProps}
            />
          );
        })
      }
      renderInput={params => (
        <TextField
          {...params}
          label={label}
          placeholder={placeholder}
          helperText={helperText}
          inputProps={{
            ...params.inputProps,
            onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
              (params.inputProps as any).onBlur?.(e);
              commitTyped();
            },
          }}
        />
      )}
    />
  );
}

function IpAllowListFields({ form, onChange }: FieldsProps) {
  const f = form.ipAllowList;
  const set = (patch: Partial<typeof f>) => onChange({ ...form, ipAllowList: { ...f, ...patch } });
  const add = (ranges: string[]) =>
    set({ sourceRange: splitEntries([...f.sourceRange, ...ranges]) });
  return (
    <Stack spacing={2}>
      <ListInput
        label="Allowed addresses and networks"
        values={f.sourceRange}
        onChange={sourceRange => set({ sourceRange })}
        options={[...PRIVATE_RANGES, ...LOCALHOST_RANGES]}
        isValid={isValidSourceRange}
        placeholder="203.0.113.7 or 10.0.0.0/8"
        helperText="IPv4 or IPv6, a single address or a CIDR network. Everyone else is rejected."
      />
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button
          size="small"
          startIcon={<Icon icon="mdi:plus" />}
          onClick={() => add(PRIVATE_RANGES)}
        >
          Private networks
        </Button>
        <Button
          size="small"
          startIcon={<Icon icon="mdi:plus" />}
          onClick={() => add(LOCALHOST_RANGES)}
        >
          Localhost
        </Button>
      </Stack>
      <Box>
        <FormControlLabel
          control={
            <Switch
              checked={f.behindProxy}
              onChange={e => set({ behindProxy: e.target.checked })}
            />
          }
          label="Traefik sits behind a load balancer or proxy"
        />
        {f.behindProxy && (
          <TextField
            type="number"
            size="small"
            label="Depth"
            value={f.depth}
            onChange={e => set({ depth: Number(e.target.value) })}
            inputProps={{ min: 1 }}
            sx={{ mt: 1, maxWidth: 160, display: 'block' }}
          />
        )}
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.5 }}>
          When a proxy hides the visitor's address, Traefik reads it from X-Forwarded-For instead:
          depth 1 is the last address added (by the proxy right in front of Traefik), 2 the one
          before it. Leave this off without such a proxy — a client can write anything into that
          header. If every visitor gets rejected or Traefik only sees node addresses, the Traefik
          Service probably needs <code>externalTrafficPolicy: Local</code>.
        </Typography>
      </Box>
      <TextField
        size="small"
        label="Reject with status"
        placeholder="403"
        value={f.rejectStatusCode}
        onChange={e => set({ rejectStatusCode: e.target.value })}
        helperText="Optional. 403 by default; 404 hides that the site exists."
        sx={{ maxWidth: 260 }}
      />
    </Stack>
  );
}

function BasicAuthFields({ form, onChange, creating }: FieldsProps) {
  const f = form.basicAuth;
  const set = (patch: Partial<typeof f>) => onChange({ ...form, basicAuth: { ...f, ...patch } });
  const secretName = creating ? basicAuthSecretName(form.name || '<name>') : f.secretName;
  const canEditCredentials = creating || f.credentialsManaged;
  return (
    <Stack spacing={2}>
      <Alert severity="info">
        One middleware holds one user. The username and password are kept in the Secret{' '}
        <code>{secretName}</code> as <code>kubernetes.io/basic-auth</code> — base64, not hashed, so
        anyone allowed to read Secrets in this namespace can read the password.
      </Alert>
      {!canEditCredentials && (
        <Alert severity="warning">
          The credentials live in Secret <code>{f.secretName || '(none)'}</code>, which was not
          created here, so this form leaves it alone. Change it in Resource Builder → Secrets.
        </Alert>
      )}
      {canEditCredentials && (
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          <TextField
            label="Username"
            value={f.username}
            onChange={e => set({ username: e.target.value })}
            autoComplete="off"
            sx={{ flex: 1 }}
          />
          <TextField
            label="Password"
            type="password"
            value={f.password}
            onChange={e => set({ password: e.target.value })}
            autoComplete="new-password"
            placeholder={creating ? '' : 'Leave empty to keep the current one'}
            InputLabelProps={creating ? undefined : { shrink: true }}
            sx={{ flex: 1 }}
          />
        </Stack>
      )}
      <TextField
        label="Realm"
        value={f.realm}
        onChange={e => set({ realm: e.target.value })}
        placeholder="traefik"
        helperText="Optional. The name some browsers show in the login prompt."
        sx={{ maxWidth: 420 }}
      />
      <FormControlLabel
        control={
          <Checkbox
            checked={f.removeHeader}
            onChange={e => set({ removeHeader: e.target.checked })}
          />
        }
        label="Don't pass the login on to the app (removes the Authorization header)"
      />
    </Stack>
  );
}

function RedirectSchemeFields({ form, onChange }: FieldsProps) {
  const f = form.redirectScheme;
  const set = (patch: Partial<typeof f>) =>
    onChange({ ...form, redirectScheme: { ...f, ...patch } });
  return (
    <Stack spacing={2}>
      <FormControlLabel
        control={
          <Checkbox checked={f.permanent} onChange={e => set({ permanent: e.target.checked })} />
        }
        label="Permanent redirect — browsers remember it"
      />
      <TextField
        size="small"
        label="HTTPS port"
        value={f.port}
        onChange={e => set({ port: e.target.value })}
        helperText="Optional. Only when HTTPS is served on a non-standard port."
        sx={{ maxWidth: 260 }}
      />
      <Typography variant="caption" color="text.secondary">
        Attach this to the route that listens on plain HTTP (usually the <code>web</code> entry
        point).
      </Typography>
    </Stack>
  );
}

function HeadersFields({ form, onChange }: FieldsProps) {
  const f = form.headers;
  const set = (patch: Partial<typeof f>) => onChange({ ...form, headers: { ...f, ...patch } });
  const hstsOptions = HSTS_OPTIONS.some(o => o.seconds === f.stsSeconds)
    ? HSTS_OPTIONS
    : [...HSTS_OPTIONS, { seconds: f.stsSeconds, label: `${f.stsSeconds} seconds (current)` }];
  const hstsOn = f.stsSeconds > 0;
  return (
    <Stack spacing={2}>
      <TextField
        select
        size="small"
        label="HSTS — force HTTPS in the browser"
        value={f.stsSeconds}
        onChange={e => set({ stsSeconds: Number(e.target.value) })}
        sx={{ maxWidth: 360 }}
      >
        {hstsOptions.map(o => (
          <MenuItem key={o.seconds} value={o.seconds}>
            {o.label}
          </MenuItem>
        ))}
      </TextField>
      <Stack direction="row" flexWrap="wrap" useFlexGap>
        <FormControlLabel
          control={
            <Checkbox
              checked={f.stsIncludeSubdomains}
              disabled={!hstsOn}
              onChange={e => set({ stsIncludeSubdomains: e.target.checked })}
            />
          }
          label="Include subdomains"
        />
        <FormControlLabel
          control={
            <Checkbox
              checked={f.stsPreload}
              disabled={!hstsOn}
              onChange={e => set({ stsPreload: e.target.checked })}
            />
          }
          label="Preload"
        />
      </Stack>
      {f.stsPreload && (
        <Alert severity="warning">
          Preload only makes sense if you submit the domain to the browsers' preload list, and
          getting off that list takes months.
        </Alert>
      )}
      <FormControlLabel
        control={
          <Checkbox checked={f.frameDeny} onChange={e => set({ frameDeny: e.target.checked })} />
        }
        label="Block embedding in frames (clickjacking protection)"
      />
      <FormControlLabel
        control={
          <Checkbox
            checked={f.contentTypeNosniff}
            onChange={e => set({ contentTypeNosniff: e.target.checked })}
          />
        }
        label="Stop browsers guessing content types (nosniff)"
      />
      <TextField
        select
        size="small"
        label="Referrer policy"
        value={f.referrerPolicy}
        onChange={e => set({ referrerPolicy: e.target.value })}
        sx={{ maxWidth: 360 }}
      >
        <MenuItem value="">Not set</MenuItem>
        {(REFERRER_POLICIES.includes(f.referrerPolicy) || !f.referrerPolicy
          ? REFERRER_POLICIES
          : [...REFERRER_POLICIES, f.referrerPolicy]
        ).map(p => (
          <MenuItem key={p} value={p}>
            {p}
          </MenuItem>
        ))}
      </TextField>
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          Extra headers sent to the app
        </Typography>
        <KeyValueEditor
          entries={f.customRequestHeaders}
          onChange={next => set({ customRequestHeaders: next })}
          allowFileUpload={false}
          placeholderKey="X-Header"
          placeholderValue="value (empty removes the header)"
        />
      </Box>
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>
          Extra headers sent to the browser
        </Typography>
        <KeyValueEditor
          entries={f.customResponseHeaders}
          onChange={next => set({ customResponseHeaders: next })}
          allowFileUpload={false}
          placeholderKey="X-Header"
          placeholderValue="value (empty removes the header)"
        />
      </Box>
    </Stack>
  );
}

function RateLimitFields({ form, onChange }: FieldsProps) {
  const f = form.rateLimit;
  const set = (patch: Partial<typeof f>) => onChange({ ...form, rateLimit: { ...f, ...patch } });
  const periods = RATE_PERIODS.some(p => p.value === f.period)
    ? RATE_PERIODS
    : [...RATE_PERIODS, { value: f.period, label: `per ${f.period} (current)` }];
  return (
    <Stack spacing={2}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
        <TextField
          size="small"
          label="Requests"
          value={f.average}
          onChange={e => set({ average: e.target.value })}
          sx={{ maxWidth: 200 }}
        />
        <TextField
          select
          size="small"
          label="Period"
          value={f.period}
          onChange={e => set({ period: e.target.value })}
          sx={{ minWidth: 180 }}
        >
          {periods.map(p => (
            <MenuItem key={p.value} value={p.value}>
              {p.label}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          label="Burst"
          value={f.burst}
          onChange={e => set({ burst: e.target.value })}
          sx={{ maxWidth: 200 }}
        />
      </Stack>
      <Typography variant="caption" color="text.secondary">
        Counted per client IP. Requests is the sustained rate; burst is how many may arrive at once
        on top of it. Clients over the limit get HTTP 429.
      </Typography>
    </Stack>
  );
}

function StripPrefixFields({ form, onChange }: FieldsProps) {
  return (
    <ListInput
      label="Prefixes to remove"
      values={form.stripPrefix.prefixes}
      onChange={prefixes => onChange({ ...form, stripPrefix: { prefixes } })}
      isValid={v => v.startsWith('/')}
      placeholder="/api"
      helperText="The app receives /api/users as /users. Each prefix starts with a slash."
    />
  );
}

export default function TraefikMiddlewareFields(props: FieldsProps) {
  switch (props.form.type) {
    case 'ipAllowList':
      return <IpAllowListFields {...props} />;
    case 'basicAuth':
      return <BasicAuthFields {...props} />;
    case 'redirectScheme':
      return <RedirectSchemeFields {...props} />;
    case 'headers':
      return <HeadersFields {...props} />;
    case 'rateLimit':
      return <RateLimitFields {...props} />;
    case 'stripPrefix':
      return <StripPrefixFields {...props} />;
  }
}
