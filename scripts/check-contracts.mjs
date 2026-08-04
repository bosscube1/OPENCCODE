/* global console, process */
/**
 * Contract drift check — keeps CONTRACTS.md in sync with the code.
 *
 * Extracts, with static regex/parsing only (no dependencies):
 *   1. every IPC channel registered in src/main (ipcMain.handle / ipc.handle,
 *      ipcMain.on, webContents.send, and the index.ts `broadcast()` helper),
 *   2. every method exposed on `window.api` from the `const api` object literal
 *      in src/preload/index.ts,
 *   3. every method documented in CONTRACTS.md — the `export interface OpencodeApi`
 *      block plus the "Preload bridge additions" fragment (fs/git/term/openEditor),
 * and asserts each code channel and method appears in CONTRACTS.md.
 *
 * Methods are compared as full dotted paths (`sessions.create` vs `projects.create`),
 * so same-named leaves in different groups can never mask each other's absence.
 *
 * Exits 0 when the contract covers the code, 1 on any gap. Channels and methods
 * documented in CONTRACTS.md but absent from the code are reported as warnings
 * (prose mentions make them lower-confidence than missing entries).
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAIN_DIR = path.join(root, 'src/main')
const PRELOAD_FILE = path.join(root, 'src/preload/index.ts')
const CONTRACTS_FILE = path.join(root, 'CONTRACTS.md')

/* ------------------------------------------------------------------ */
/* 1. IPC channels registered in src/main                              */
/* ------------------------------------------------------------------ */

function mainSources() {
  const files = []
  // Recursive: a registration added in a future subdirectory must not be
  // skipped silently. `__tests__` holds no registrations.
  for (const entry of readdirSync(MAIN_DIR, { recursive: true })) {
    const relative = String(entry)
    if (relative.split(/[\\/]/).includes('__tests__')) continue
    if (relative.endsWith('.ts') && !relative.endsWith('.test.ts')) {
      files.push(path.join(MAIN_DIR, relative))
    }
  }
  return files
}

function extractChannels() {
  // `ipc.handle` covers the register(ipc) delegation pattern in the service
  // modules (fsService/gitService/terminal/openEditor receive `ipcMain` as a
  // parameter named `ipc`). removeHandler/removeAllListeners take variables or
  // re-list the same names, so only literal registrations are matched. Both
  // quote styles are matched — a double-quoted channel must not evade the check.
  const invoke = /(?:ipcMain|ipc)\.handle\(\s*['"]([^'"]+)['"]/g
  const listen = /\bipcMain\.on\(\s*['"]([^'"]+)['"]/g
  const send = /\.send\(\s*['"]([^'"]+)['"]/g
  // index.ts fans events out through a local broadcast('oc:...', payload) helper.
  const broadcast = /\bbroadcast\(\s*['"]([^'"]+)['"]/g

  const invokeChannels = new Set()
  const listenChannels = new Set()
  const sendChannels = new Set()

  for (const file of mainSources()) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(invoke)) invokeChannels.add(match[1])
    for (const match of source.matchAll(listen)) listenChannels.add(match[1])
    for (const match of source.matchAll(send)) sendChannels.add(match[1])
    for (const match of source.matchAll(broadcast)) sendChannels.add(match[1])
  }

  return {
    invoke: [...invokeChannels].sort(),
    listen: [...listenChannels].sort(),
    send: [...sendChannels].sort()
  }
}

/* ------------------------------------------------------------------ */
/* 2. window.api methods from src/preload/index.ts                     */
/* ------------------------------------------------------------------ */

/**
 * Walk the `const api: OpencodeApi = { ... }` object literal using its
 * indentation: a `key: {` line opens a group, any other `key: ...` line is a
 * leaf method. Produces dotted paths like `sessions.list` or
 * `nanogpt.images.list`.
 */
function extractPreloadMethods() {
  const source = readFileSync(PRELOAD_FILE, 'utf8')
  // Tolerate CRLF: `.` does not match `\r`, which would break `$`-anchored line regexes.
  const lines = source.split(/\r?\n/)

  const start = lines.findIndex((line) => /^const api\b/.test(line))
  if (start === -1) throw new Error('could not find `const api` in src/preload/index.ts')

  const methods = []
  const stack = [] // [{ key, depth }]

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^}/.test(line)) break // closing brace of the api object at column 0

    const match = /^(\s+)([A-Za-z_$][\w$]*):\s*(.*)$/.exec(line)
    if (!match) continue
    const depth = match[1].length
    const key = match[2]
    const rest = match[3]

    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop()

    if (rest.startsWith('{')) {
      stack.push({ key, depth })
    } else {
      methods.push([...stack.map((frame) => frame.key), key].join('.'))
    }
  }

  return methods.sort()
}

/* ------------------------------------------------------------------ */
/* 3. window.api methods documented in CONTRACTS.md                    */
/* ------------------------------------------------------------------ */

/**
 * Walk a TypeScript interface-style member listing (member lines like
 * `list(directory: string): Promise<...>`, group openers `key: {`) with the
 * same indentation-stack rule as the preload walker, producing dotted paths.
 * Single-line groups (`vcs: { get(directory: string): ... }`) contribute their
 * inline leaves. `startIndex` is the line holding the opening brace or fence;
 * walking stops at the first line matching `stopPattern`.
 */
function walkInterfaceBlock(lines, startIndex, stopPattern) {
  const methods = []
  const stack = [] // [{ key, depth }]

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (stopPattern.test(line)) break

    const match = /^(\s*)([A-Za-z_$][\w$]*)(.*)$/.exec(line)
    if (!match) continue
    const depth = match[1].length
    const key = match[2]
    const rest = match[3]

    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop()

    const group = /^\s*:\s*\{(.*)$/.exec(rest)
    if (group) {
      const inline = /^(.*?)\}\s*(?:\/\/.*)?$/.exec(group[1])
      if (inline) {
        // Single-line group: `vcs: { get(directory: string): Promise<...> }`.
        for (const leaf of inline[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
          methods.push([...stack.map((frame) => frame.key), key, leaf[1]].join('.'))
        }
      } else {
        stack.push({ key, depth })
      }
    } else if (/^\s*\(/.test(rest)) {
      methods.push([...stack.map((frame) => frame.key), key].join('.'))
    }
    // Anything else (comments, continued expressions) is not a member line.
  }

  return methods
}

/**
 * Dotted method paths documented in CONTRACTS.md, taken from the two bridge
 * listings: the `export interface OpencodeApi` block and the "Preload bridge
 * additions" fragment (which carries fs/git/term/openEditor). Both blocks must
 * exist — a missing one means the doc was restructured and this script needs
 * updating, so that is a hard error rather than a silent pass.
 */
function extractDocumentedMethods(contracts) {
  const lines = contracts.split(/\r?\n/)
  const blocks = []

  const interfaceStart = lines.findIndex((line) => /^export interface OpencodeApi\s*\{/.test(line))
  if (interfaceStart === -1) throw new Error('could not find `export interface OpencodeApi` in CONTRACTS.md')
  blocks.push({ start: interfaceStart, stop: /^}/ })

  const additionsHeading = lines.findIndex((line) => /^### Preload bridge additions/.test(line))
  if (additionsHeading === -1) throw new Error('could not find the `Preload bridge additions` section in CONTRACTS.md')
  const fenceStart = lines.findIndex((line, index) => index > additionsHeading && /^```/.test(line))
  if (fenceStart === -1) throw new Error('could not find the code fence under `Preload bridge additions`')
  blocks.push({ start: fenceStart, stop: /^```/ })

  const methods = []
  for (const block of blocks) methods.push(...walkInterfaceBlock(lines, block.start, block.stop))
  return methods.sort()
}

/* ------------------------------------------------------------------ */
/* 4. Channels documented in CONTRACTS.md (for the extras report)      */
/* ------------------------------------------------------------------ */

function extractDocumentedChannels(contracts) {
  const documented = new Set()
  const pattern = /'((?:oc|[a-z][a-z-]*):[a-zA-Z][\w:-]*)'/g
  for (const match of contracts.matchAll(pattern)) documented.add(match[1])
  return [...documented].sort()
}

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */

const contracts = readFileSync(CONTRACTS_FILE, 'utf8')
const channels = extractChannels()
const methods = extractPreloadMethods()
const documentedMethods = extractDocumentedMethods(contracts)
const codeChannels = [...new Set([...channels.invoke, ...channels.listen, ...channels.send])]

const missingInvoke = channels.invoke.filter((channel) => !contracts.includes(channel))
const missingListen = channels.listen.filter((channel) => !contracts.includes(channel))
const missingSend = channels.send.filter((channel) => !contracts.includes(channel))
const missingMethods = methods.filter((method) => !documentedMethods.includes(method))
const extraChannels = extractDocumentedChannels(contracts).filter(
  (channel) => !codeChannels.includes(channel)
)
const extraMethods = documentedMethods.filter((method) => !methods.includes(method))

console.log('contract drift check')
console.log(`  invoke channels in src/main:      ${channels.invoke.length}`)
console.log(`  listener channels in src/main:    ${channels.listen.length}`)
console.log(`  send channels in src/main:        ${channels.send.length}`)
console.log(`  window.api methods in preload:    ${methods.length}`)
console.log(`  window.api methods documented:    ${documentedMethods.length}`)
console.log('')

let failed = false

function reportMissing(title, entries, format) {
  if (entries.length === 0) {
    console.log(`OK      ${title}: all documented in CONTRACTS.md`)
    return
  }
  failed = true
  console.log(`MISSING ${title} not found in CONTRACTS.md:`)
  for (const entry of entries) console.log(`          ${format(entry)}`)
}

reportMissing('invoke channels', missingInvoke, (channel) => `'${channel}'`)
reportMissing('listener channels', missingListen, (channel) => `'${channel}'`)
reportMissing('send channels', missingSend, (channel) => `'${channel}'`)
reportMissing('window.api methods', missingMethods, (method) => `window.api.${method}`)

if (extraChannels.length > 0) {
  console.log('WARNING channels documented in CONTRACTS.md but not registered in src/main:')
  for (const channel of extraChannels) console.log(`          '${channel}'`)
}

if (extraMethods.length > 0) {
  console.log('WARNING window.api methods documented in CONTRACTS.md but not exposed by preload:')
  for (const method of extraMethods) console.log(`          window.api.${method}`)
}

/* ------------------------------------------------------------------ */
/* 5. Cross-process constant mirrors                                   */
/* ------------------------------------------------------------------ */

/*
 * These encode documented NanoGPT API limits. The renderer cannot import the main-process
 * module that owns each one (those pull in Electron `app` / node `fs`), so the value is
 * duplicated in `src/renderer/src/lib/types.ts`. Duplication is the constraint; silent
 * divergence is not — a limit that drifts on one side of the boundary is a wrong number on
 * a user-facing gauge.
 */
const MIRRORED_CONSTANTS = [
  { name: 'WEEKLY_INPUT_TOKEN_CAP', source: 'src/main/tokenBudgetTracker.ts' },
  { name: 'DAILY_FREE_IMAGE_CAP', source: 'src/main/nanogptImages.ts' }
]

const RENDERER_TYPES_FILE = path.join(root, 'src/renderer/src/lib/types.ts')

function constantValue(source, name) {
  const match = source.match(new RegExp(`export const ${name}\\s*=\\s*([0-9_]+)`))
  return match ? match[1].replace(/_/g, '') : null
}

const rendererTypes = readFileSync(RENDERER_TYPES_FILE, 'utf8')
const drifted = []
for (const { name, source } of MIRRORED_CONSTANTS) {
  const mainValue = constantValue(readFileSync(path.join(root, source), 'utf8'), name)
  const rendererValue = constantValue(rendererTypes, name)
  if (mainValue === null || rendererValue === null || mainValue !== rendererValue) {
    drifted.push({ name, source, mainValue, rendererValue })
  }
}

if (drifted.length === 0) {
  console.log('OK      mirrored constants: main and renderer agree')
} else {
  failed = true
  console.log('MISMATCH mirrored constants differ between main and renderer:')
  for (const { name, source, mainValue, rendererValue } of drifted) {
    console.log(`          ${name}: ${source} = ${mainValue ?? 'NOT FOUND'}, renderer types.ts = ${rendererValue ?? 'NOT FOUND'}`)
  }
}

console.log('')
if (failed) {
  console.log('FAIL: CONTRACTS.md is out of sync with the code. Update CONTRACTS.md (or the code) and re-run.')
  process.exit(1)
}
console.log('PASS: CONTRACTS.md covers every registered channel and bridge method.')
