// Assemble the single-file client bundle the Desktop module loader expects.
//
//   node scripts/build-client.mjs
//
// src/client/index.js is the hand-written module with `/*STYLES*/` as the only
// placeholder; this script inlines src/client/styles.css there and writes
// lib/client.js. Sources stay separate for readability, the artifact stays one
// file because Desktop never builds a workbench package itself.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'src', 'client', 'index.js')
const styles = join(root, 'src', 'client', 'styles.css')
const output = join(root, 'lib', 'client.js')

const [source, css] = await Promise.all([readFile(entry, 'utf8'), readFile(styles, 'utf8')])
if (!source.includes('/*STYLES*/')) throw new Error('src/client/index.js is missing the /*STYLES*/ placeholder')

// Backticks and `${` inside CSS would break the template literal carrying it.
const escaped = css.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${')
const built = source.replace('/*STYLES*/', escaped)

await mkdir(dirname(output), { recursive: true })
await writeFile(output, built, 'utf8')
console.log(`built lib/client.js — ${built.length} bytes (css ${css.length} bytes)`)
