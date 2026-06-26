import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli/index.ts',
    daemon: 'src/daemon/index.ts',
    'hooks/hook-permission-telegram': 'src/hooks/hook-permission-telegram.ts',
    'hooks/hook-ask-telegram': 'src/hooks/hook-ask-telegram.ts',
    'hooks/hook-planmode-telegram': 'src/hooks/hook-planmode-telegram.ts',
    'hooks/hook-crash-alert': 'src/hooks/hook-crash-alert.ts',
    'hooks/hook-compact-telegram': 'src/hooks/hook-compact-telegram.ts',
    'hooks/hook-extract-facts': 'src/hooks/hook-extract-facts.ts',
    'hooks/hook-idle-flag': 'src/hooks/hook-idle-flag.ts',
    'hooks/hook-context-status': 'src/hooks/hook-context-status.ts',
    'hooks/hook-loop-detector': 'src/hooks/hook-loop-detector.ts',
    'hooks/hook-permission-slack': 'src/hooks/hook-permission-slack.ts',
    'hooks/hook-ask-slack': 'src/hooks/hook-ask-slack.ts',
    'hooks/hook-planmode-slack': 'src/hooks/hook-planmode-slack.ts',
    'hooks/hook-crash-alert-slack': 'src/hooks/hook-crash-alert-slack.ts',
    'hooks/hook-compact-slack': 'src/hooks/hook-compact-slack.ts',
  },
  format: ['cjs'],
  target: 'node20',
  clean: true,
  splitting: false,
  sourcemap: true,
  dts: false,
  shims: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: ['node-pty'],
});
