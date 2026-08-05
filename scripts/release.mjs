/* global console, process */
/**
 * One-step release driver — keeps package.json, package-lock.json,
 * CHANGELOG.md, the git tag, and the Windows installer artifacts in lockstep
 * so versions can never drift the way they once did (git 0.6.0 vs dist 0.7.0).
 *
 * Usage:
 *   node scripts/release.mjs <version> [--dry-run]
 *
 * Steps (in order, aborting on the first failure):
 *   1. Validate <version> (semver-ish, strictly greater than package.json).
 *   2. Refuse to run on a dirty working tree.
 *   3. Quality gate: npm run typecheck, lint, test.
 *   4. Bump version via `npm version <v> --no-git-tag-version` (package.json
 *      AND package-lock.json).
 *   5. Prepend a CHANGELOG.md skeleton for <v> (warn-only if already there).
 *   6. Build Windows installers: npm run dist:win.
 *   7. Commit the bump and create an annotated tag v<v>.
 *   8. Print the remaining manual steps (push, GitHub Release, uploads).
 *
 * --dry-run prints every step without touching git, npm, or the filesystem.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_JSON = path.join(root, 'package.json')
const CHANGELOG = path.join(root, 'CHANGELOG.md')

// npm is a .cmd shim on Windows and can only be spawned through a shell there
// (CVE-2024-27980); args stay a fixed argv array either way — no interpolation.
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npmNeedsShell = process.platform === 'win32'

function fail(message) {
  console.error(`release: ERROR: ${message}`)
  process.exit(1)
}

/* ------------------------------------------------------------------ */
/* args                                                                */
/* ------------------------------------------------------------------ */

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const version = args.find((arg) => arg !== '--dry-run')

if (!version) {
  fail('missing version argument. Usage: node scripts/release.mjs <version> [--dry-run]')
}

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`'${version}' is not a semver-ish version (expected e.g. 0.7.1)`)
}

const currentVersion = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')).version
const toParts = (v) => v.split('.').map(Number)
const [nextMajor, nextMinor, nextPatch] = toParts(version)
const [curMajor, curMinor, curPatch] = toParts(currentVersion)
const greater =
  nextMajor > curMajor ||
  (nextMajor === curMajor && nextMinor > curMinor) ||
  (nextMajor === curMajor && nextMinor === curMinor && nextPatch > curPatch)

if (!greater) {
  fail(`version ${version} is not greater than the current package.json version ${currentVersion}`)
}

/* ------------------------------------------------------------------ */
/* step runners                                                        */
/* ------------------------------------------------------------------ */

let step = 0

/** Print a step header; in dry-run mode nothing after the header executes. */
function announce(title) {
  step += 1
  console.log(`\n[${step}] ${title}`)
  return !dryRun
}

/** Run a command with inherited stdio; abort the release on non-zero exit. */
function runOrFail(command, argv, label) {
  console.log(`    $ ${command} ${argv.join(' ')}`)
  const result = spawnSync(command, argv, {
    cwd: root,
    stdio: 'inherit',
    shell: command === npmCommand && npmNeedsShell
  })
  if (result.error) fail(`${label}: could not start '${command}': ${result.error.message}`)
  if (result.status !== 0) fail(`${label} failed (exit code ${result.status}) — release aborted`)
}

/* ------------------------------------------------------------------ */
/* 1–2. preconditions                                                  */
/* ------------------------------------------------------------------ */

console.log(`release: ${currentVersion} -> ${version}${dryRun ? ' (dry run — no side effects)' : ''}`)

if (announce('check for a clean working tree (git status --porcelain)')) {
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
  if (status.trim() !== '') {
    fail(`working tree is dirty — commit or stash first:\n${status.trimEnd()}`)
  }
}

/* ------------------------------------------------------------------ */
/* 3. quality gate                                                     */
/* ------------------------------------------------------------------ */

for (const gate of ['typecheck', 'lint', 'test']) {
  if (announce(`quality gate: npm run ${gate}`)) {
    runOrFail(npmCommand, ['run', gate], `quality gate 'npm run ${gate}'`)
  }
}

/* ------------------------------------------------------------------ */
/* 4. version bump (package.json + package-lock.json)                  */
/* ------------------------------------------------------------------ */

if (announce(`bump version: npm version ${version} --no-git-tag-version`)) {
  runOrFail(npmCommand, ['version', version, '--no-git-tag-version'], 'npm version bump')
}

/* ------------------------------------------------------------------ */
/* 5. CHANGELOG skeleton                                               */
/* ------------------------------------------------------------------ */

if (announce(`prepend a ${version} skeleton to CHANGELOG.md`)) {
  const changelog = readFileSync(CHANGELOG, 'utf8')
  if (changelog.includes(`## [${version}]`)) {
    console.log(`    WARNING: CHANGELOG.md already has a [${version}] section — leaving it untouched`)
  } else {
    const today = new Date().toISOString().slice(0, 10)
    const section = [
      `## [${version}] - ${today}`,
      '',
      '### Added',
      '',
      '- ',
      '',
      '### Changed',
      '',
      '- ',
      '',
      '### Fixed',
      '',
      '- ',
      '',
      ''
    ].join('\n')
    const lines = changelog.split('\n')
    // Insert before the first existing release heading, i.e. right after the
    // `# Changelog` header block. Fall back to appending if none exists.
    const firstRelease = lines.findIndex((line) => /^## \[/.test(line))
    lines.splice(firstRelease === -1 ? lines.length : firstRelease, 0, section)
    writeFileSync(CHANGELOG, lines.join('\n'))
    console.log(`    inserted an empty [${version}] skeleton dated ${today} — fill it in before publishing`)
  }
}

/* ------------------------------------------------------------------ */
/* 6. build Windows installers                                         */
/* ------------------------------------------------------------------ */

if (announce('build Windows installers: npm run dist:win')) {
  runOrFail(npmCommand, ['run', 'dist:win'], 'installer build')
}

/* ------------------------------------------------------------------ */
/* 7. commit + annotated tag                                           */
/* ------------------------------------------------------------------ */

if (announce(`commit the release and tag v${version}`)) {
  runOrFail('git', ['commit', '-am', `chore: release v${version}`], 'release commit')
  runOrFail('git', ['tag', '-a', `v${version}`, '-m', `v${version}`], 'annotated tag')
}

/* ------------------------------------------------------------------ */
/* 8. remaining manual steps                                           */
/* ------------------------------------------------------------------ */

const setupExe = `dist/OpenCode-Desktop-${version}-setup.exe`
console.log(`
release ${version} ${dryRun ? 'would be' : 'is'} committed and tagged. Remaining manual steps:

  1. Push the commit and tag:        git push --follow-tags
  2. Create a GitHub Release for tag v${version}
  3. Upload the release assets:
       ${setupExe}
       dist/latest.yml
       ${setupExe}.blockmap
`)
