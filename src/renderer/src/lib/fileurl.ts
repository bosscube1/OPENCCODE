/** Normalizes paths to forward slashes, joins with single slash, collapses duplicates. */
export function joinPath(dir: string, rel: string): string {
  // If rel has a Windows drive letter, it's truly absolute
  if (rel.match(/^[a-zA-Z]:[/\\]/)) {
    return rel.replace(/\\/g, '/')
  }

  // Strip leading slashes/backslashes from rel (handle POSIX-style paths as relative)
  const relCleaned = rel.replace(/^[/\\]+/, '')

  const normalized = `${dir}/${relCleaned}`.replace(/\\/g, '/').replace(/\/+/g, '/')
  return normalized
}

/**
 * Converts an absolute file path to RFC-compliant file:// URL.
 * Windows: C:\Users\a b\x.ts → file:///C:/Users/a%20b/x.ts
 * POSIX: /home/a b/x.ts → file:///home/a%20b/x.ts
 */
export function toFileUrl(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/')
  const encoded = encodeURI(normalized)
  // Ensure Windows drive letter has slash before it
  const formatted = encoded.startsWith('/') ? encoded : `/${encoded}`
  return `file://${formatted}`
}

/** Maps file extensions to MIME types. Fallback to application/octet-stream. */
export function guessMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''

  const mimeMap: Record<string, string> = {
    // Code
    ts: 'text/typescript',
    tsx: 'text/typescript',
    js: 'text/javascript',
    jsx: 'text/javascript',
    py: 'text/x-python',
    rs: 'text/x-rust',
    go: 'text/x-go',
    java: 'text/x-java',
    c: 'text/x-c',
    h: 'text/x-c',
    cpp: 'text/x-c++',
    hpp: 'text/x-c++',
    cs: 'text/x-csharp',
    rb: 'text/x-ruby',
    php: 'application/x-httpd-php',
    sh: 'application/x-sh',
    json: 'application/json',
    yaml: 'application/x-yaml',
    yml: 'application/x-yaml',
    toml: 'application/toml',
    md: 'text/markdown',
    html: 'text/html',
    css: 'text/css',
    xml: 'application/xml',
    sql: 'application/sql',
    txt: 'text/plain',
    log: 'text/plain',
    // Images
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
  }

  return mimeMap[ext] ?? 'application/octet-stream'
}
