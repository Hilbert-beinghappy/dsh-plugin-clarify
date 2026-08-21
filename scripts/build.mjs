#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = fileURLToPath(new URL('../lib/', import.meta.url))

rmSync(output, { recursive: true, force: true })
execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], {
  cwd: root,
  stdio: 'inherit',
})
