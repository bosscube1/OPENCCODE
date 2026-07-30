// A curated, LOCAL-only catalog of well-known first-party Model Context Protocol
// servers. This app is local-first and deliberately has no hosted MCP registry —
// see AGENTS.md. Nothing here is fetched at runtime; it is a static bundle constant.
//
// MAINTENANCE: this list has an owner and WILL go stale. Package names, invocation
// commands, and env var names for third-party MCP servers change without notice.
// Before trusting an entry, verify the command against the server's own docs/README.
// Prefer leaving a server out over shipping a command that no longer resolves.

import type { KeyValueRow } from './mcp'

export type CatalogEntry = {
  id: string
  name: string
  description: string
  kind: 'local' | 'remote'
  command?: string
  url?: string
  env?: { key: string; placeholder: string; required: boolean; secret: boolean }[]
  docsUrl?: string
}

export const MCP_CATALOG: readonly CatalogEntry[] = [
  {
    id: 'filesystem',
    name: 'filesystem',
    description: 'Read and write files within an allowed local directory.',
    kind: 'local',
    command: 'npx -y @modelcontextprotocol/server-filesystem "C:\\Work"',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem'
  },
  {
    id: 'git',
    name: 'git',
    description: 'Read, search, and inspect a local git repository.',
    kind: 'local',
    command: 'uvx mcp-server-git --repository "C:\\Work"',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git'
  },
  {
    id: 'fetch',
    name: 'fetch',
    description: 'Fetch and convert web pages to markdown for the model to read.',
    kind: 'local',
    command: 'uvx mcp-server-fetch',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch'
  },
  {
    id: 'memory',
    name: 'memory',
    description: 'A simple local knowledge-graph memory store between sessions.',
    kind: 'local',
    command: 'npx -y @modelcontextprotocol/server-memory',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory'
  },
  {
    id: 'sequential-thinking',
    name: 'sequential-thinking',
    description: 'Structured step-by-step reasoning scratchpad for the model.',
    kind: 'local',
    command: 'npx -y @modelcontextprotocol/server-sequential-thinking',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking'
  },
  {
    id: 'sqlite',
    name: 'sqlite',
    description: 'Query and inspect a local SQLite database file.',
    kind: 'local',
    command: 'uvx mcp-server-sqlite --db-path "C:\\Work\\data.db"',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite'
  },
  {
    id: 'time',
    name: 'time',
    description: 'Current time and timezone conversion for the model.',
    kind: 'local',
    command: 'uvx mcp-server-time',
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time'
  },
  {
    id: 'github',
    name: 'github',
    description: 'Read and manage GitHub repositories, issues, and pull requests.',
    kind: 'local',
    command: 'npx -y @modelcontextprotocol/server-github',
    env: [
      { key: 'GITHUB_PERSONAL_ACCESS_TOKEN', placeholder: '', required: true, secret: true }
    ],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github'
  }
] as const

export function findCatalogEntry(id: string): CatalogEntry | undefined {
  return MCP_CATALOG.find((entry) => entry.id === id)
}

export function searchCatalog(query: string): CatalogEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...MCP_CATALOG]
  return MCP_CATALOG.filter(
    (entry) => entry.name.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle)
  )
}

export function catalogEntryToFormValues(entry: CatalogEntry): {
  kind: 'local' | 'remote'
  name: string
  command: string
  url: string
  environment: KeyValueRow[]
  headers: KeyValueRow[]
} {
  return {
    kind: entry.kind,
    name: entry.name,
    command: entry.command ?? '',
    url: entry.url ?? '',
    environment: (entry.env ?? []).map((row) => ({ key: row.key, value: '' })),
    headers: []
  }
}
