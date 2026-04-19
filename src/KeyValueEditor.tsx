import { Icon } from '@iconify/react';
import {
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import React, { useRef, useState } from 'react';

export type KVEntry = {
  key: string;
  value: string;
  alreadyEncoded?: boolean;
};

export type KeyValueEditorProps = {
  entries: KVEntry[];
  onChange: (next: KVEntry[]) => void;
  valueLabel?: string;
  hideValues?: boolean;
  allowFileUpload?: boolean;
  allowBase64Toggle?: boolean;
  lockedKeys?: string[];
  placeholderKey?: string;
  placeholderValue?: string;
};

export default function KeyValueEditor({
  entries,
  onChange,
  valueLabel = 'Value',
  hideValues = false,
  allowFileUpload = true,
  allowBase64Toggle = false,
  lockedKeys,
  placeholderKey = 'my-key',
  placeholderValue = 'value',
}: KeyValueEditorProps) {
  return (
    <Stack spacing={1.5}>
      {entries.map((e, i) => (
        <Row
          key={i}
          entry={e}
          valueLabel={valueLabel}
          hideValues={hideValues}
          allowFileUpload={allowFileUpload}
          allowBase64Toggle={allowBase64Toggle}
          placeholderKey={placeholderKey}
          placeholderValue={placeholderValue}
          keyLocked={lockedKeys?.includes(e.key)}
          onChange={next => onChange(entries.map((x, j) => (j === i ? next : x)))}
          onRemove={
            lockedKeys?.includes(e.key)
              ? undefined
              : () => onChange(entries.filter((_, j) => j !== i))
          }
        />
      ))}
      <Box>
        <Button
          size="small"
          startIcon={<Icon icon="mdi:plus" />}
          onClick={() =>
            onChange([...entries, { key: '', value: '', alreadyEncoded: false }])
          }
        >
          Add entry
        </Button>
      </Box>
    </Stack>
  );
}

function Row({
  entry,
  valueLabel,
  hideValues,
  allowFileUpload,
  allowBase64Toggle,
  placeholderKey,
  placeholderValue,
  keyLocked,
  onChange,
  onRemove,
}: {
  entry: KVEntry;
  valueLabel: string;
  hideValues: boolean;
  allowFileUpload: boolean;
  allowBase64Toggle: boolean;
  placeholderKey: string;
  placeholderValue: string;
  keyLocked?: boolean;
  onChange: (next: KVEntry) => void;
  onRemove?: () => void;
}) {
  const [reveal, setReveal] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  async function handleFile(file: File) {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);
    onChange({
      key: entry.key || file.name,
      value: b64,
      alreadyEncoded: true,
    });
  }

  const isSecretMasked = hideValues && !reveal;

  return (
    <Stack
      direction={{ xs: 'column', md: 'row' }}
      spacing={1}
      alignItems="flex-start"
      sx={{ p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}
    >
      <TextField
        label="Key"
        size="small"
        value={entry.key}
        onChange={e => onChange({ ...entry, key: e.target.value })}
        placeholder={placeholderKey}
        disabled={keyLocked}
        sx={{ minWidth: 180 }}
      />
      <TextField
        label={valueLabel}
        size="small"
        value={entry.value}
        onChange={e => onChange({ ...entry, value: e.target.value })}
        placeholder={placeholderValue}
        multiline
        minRows={1}
        maxRows={8}
        type={isSecretMasked ? 'password' : 'text'}
        sx={{ flex: 1, width: '100%' }}
      />
      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ pt: 0.5 }}>
        {hideValues && (
          <Tooltip title={reveal ? 'Hide value' : 'Show value'}>
            <IconButton size="small" onClick={() => setReveal(r => !r)}>
              <Icon icon={reveal ? 'mdi:eye-off-outline' : 'mdi:eye-outline'} />
            </IconButton>
          </Tooltip>
        )}
        {allowFileUpload && (
          <>
            <input
              ref={fileRef}
              type="file"
              hidden
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = '';
              }}
            />
            <Tooltip title="Load value from file (contents will be base64-encoded)">
              <IconButton size="small" onClick={() => fileRef.current?.click()}>
                <Icon icon="mdi:file-upload-outline" />
              </IconButton>
            </Tooltip>
          </>
        )}
        {onRemove && (
          <Tooltip title="Remove entry">
            <IconButton size="small" onClick={onRemove}>
              <Icon icon="mdi:delete-outline" />
            </IconButton>
          </Tooltip>
        )}
      </Stack>
      {allowBase64Toggle && (
        <FormControlLabel
          sx={{ ml: 0 }}
          control={
            <Checkbox
              size="small"
              checked={entry.alreadyEncoded ?? false}
              onChange={e => onChange({ ...entry, alreadyEncoded: e.target.checked })}
            />
          }
          label={
            <Typography variant="caption">value is already base64</Typography>
          }
        />
      )}
    </Stack>
  );
}
