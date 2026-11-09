import { Icon } from '@iconify/react';
import { Box, Button, Paper, Stack, Typography } from '@mui/material';
import React from 'react';

/**
 * The "YAML preview" card every builder page shows under its form.
 *
 * `placeholder` replaces the code block, e.g. with the validation errors, while the form is
 * not yet complete enough to produce manifests.
 */
export default function YamlPreview({
  yaml,
  title = 'YAML preview',
  caption,
  placeholder,
  maxHeight = 320,
}: {
  yaml: string;
  title?: string;
  caption?: React.ReactNode;
  placeholder?: React.ReactNode;
  maxHeight?: number;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="h6">{title}</Typography>
        <Button
          size="small"
          startIcon={<Icon icon="mdi:content-copy" />}
          onClick={() => navigator.clipboard.writeText(yaml).catch(() => {})}
          disabled={!yaml || Boolean(placeholder)}
        >
          Copy
        </Button>
      </Stack>
      {caption && (
        <Typography variant="caption" color="text.secondary">
          {caption}
        </Typography>
      )}
      {placeholder ?? (
        <Box
          component="pre"
          sx={{
            m: 0,
            mt: 1,
            p: 2,
            backgroundColor: 'action.hover',
            fontFamily: 'monospace',
            fontSize: 13,
            overflow: 'auto',
            maxHeight,
            borderRadius: 1,
          }}
        >
          {yaml}
        </Box>
      )}
    </Paper>
  );
}
