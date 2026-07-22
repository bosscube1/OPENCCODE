export type KeyValueRow = { key: string; value: string }

/** Split a command without invoking a shell. Supports single/double quotes and quoted empty args. */
export function splitCommandLine(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let started = false

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (quote) {
      if (character === quote) {
        quote = null
        started = true
      } else if (character === '\\' && quote === '"' && index + 1 < input.length && ['"', '\\'].includes(input[index + 1])) {
        current += input[index + 1]
        index += 1
      } else {
        current += character
      }
    } else if (character === "'" || character === '"') {
      quote = character
      started = true
    } else if (/\s/.test(character)) {
      if (started) {
        args.push(current)
        current = ''
        started = false
      }
    } else {
      current += character
      started = true
    }
  }

  if (quote) throw new Error('Command contains an unclosed quote.')
  if (started) args.push(current)
  if (args.length === 0) throw new Error('Enter a command to run.')
  return args
}

/** Convert editable rows to a trimmed object while rejecting ambiguous entries. */
export function rowsToRecord(rows: KeyValueRow[], label: string): Record<string, string> | undefined {
  const result: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    const value = row.value.trim()
    if (!key && !value) continue
    if (!key) throw new Error(`${label} keys cannot be empty.`)
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new Error(`${label} key “${key}” is duplicated.`)
    }
    result[key] = value
  }
  return Object.keys(result).length > 0 ? result : undefined
}
