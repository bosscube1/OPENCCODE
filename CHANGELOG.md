# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - 2026-08-04

### Added

- Sidebar subagent section and promptable subagent tabs (PR #4)
- `ROADMAP.md` — nine-module plan derived from a fresh audit of the main process, renderer, and test/CI/release surface

### Fixed

- Windows installer and portable exe rebuilt against current `main` — the previous `dist/` artifacts were labelled 0.7.0 but built from an uncommitted version bump
- Two stale claims corrected in `PRODUCTION_PLAN.md` and `CONTINUATION.md` (the p2/p3 branches are merged; npm audit is 6 findings, not 21)
