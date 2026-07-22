/**
 * Lazy highlight.js singleton for syntax highlighting code blocks and diffs.
 */
import hljs from 'highlight.js/lib/core'
// Import common languages to keep bundle small (~60-90 KB lazy chunk)
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import yaml from 'highlight.js/lib/languages/yaml'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import sql from 'highlight.js/lib/languages/sql'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import java from 'highlight.js/lib/languages/java'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import diff from 'highlight.js/lib/languages/diff'
import markdown from 'highlight.js/lib/languages/markdown'
import dockerfile from 'highlight.js/lib/languages/dockerfile'

let registered = false

export function initHighlighting(): void {
  if (registered) return
  registered = true
  hljs.registerLanguage('typescript', typescript)
  hljs.registerLanguage('ts', typescript)
  hljs.registerLanguage('javascript', javascript)
  hljs.registerLanguage('js', javascript)
  hljs.registerLanguage('python', python)
  hljs.registerLanguage('py', python)
  hljs.registerLanguage('bash', bash)
  hljs.registerLanguage('sh', bash)
  hljs.registerLanguage('shell', bash)
  hljs.registerLanguage('json', json)
  hljs.registerLanguage('yaml', yaml)
  hljs.registerLanguage('yml', yaml)
  hljs.registerLanguage('css', css)
  hljs.registerLanguage('html', xml)
  hljs.registerLanguage('xml', xml)
  hljs.registerLanguage('sql', sql)
  hljs.registerLanguage('go', go)
  hljs.registerLanguage('rust', rust)
  hljs.registerLanguage('java', java)
  hljs.registerLanguage('c', c)
  hljs.registerLanguage('cpp', cpp)
  hljs.registerLanguage('csharp', csharp)
  hljs.registerLanguage('cs', csharp)
  hljs.registerLanguage('diff', diff)
  hljs.registerLanguage('markdown', markdown)
  hljs.registerLanguage('md', markdown)
  hljs.registerLanguage('dockerfile', dockerfile)
}

export function highlightCode(code: string, lang?: string): string | null {
  if (!code || code.length > 50_000) return null
  initHighlighting()
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang }).value
    } catch {
      return null
    }
  }
  return null
}
