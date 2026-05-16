import type { PromptTemplate } from '../../preload'

export const BUILT_IN_TEMPLATES: PromptTemplate[] = [
  {
    name: 'summarize',
    body: 'Give me a concise bullet-point summary of the recent transcript.'
  },
  {
    name: 'translate-en',
    body: 'Translate the recent transcript to natural English.'
  },
  {
    name: 'translate-ja',
    body: 'Translate the recent transcript to natural Japanese.'
  },
  {
    name: 'glossary',
    body: 'List any non-trivial terms, names, or jargon from the recent transcript with one-line definitions.'
  },
  {
    name: 'explain',
    body: 'Explain what was just discussed as if to someone new to the topic.'
  },
  {
    name: 'quote',
    body: 'Quote the most striking line or two from the recent transcript verbatim.'
  }
]

// User-defined entries with the same name override the built-in. Built-ins
// stay available for any name the user didn't shadow.
export function mergeTemplates(user: PromptTemplate[]): PromptTemplate[] {
  const byName = new Map<string, PromptTemplate>()
  for (const t of BUILT_IN_TEMPLATES) byName.set(t.name.toLowerCase(), t)
  for (const t of user) {
    const name = t.name.trim()
    if (!name) continue
    byName.set(name.toLowerCase(), { name, body: t.body })
  }
  return Array.from(byName.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  )
}

// Returns templates whose name starts with `query` (case-insensitive). The
// composer enables the palette only when the input looks like `/<word>`, so
// `query` is whatever appears after the leading slash and before the first
// whitespace.
export function filterTemplates(
  all: PromptTemplate[],
  query: string
): PromptTemplate[] {
  const q = query.toLowerCase()
  if (!q) return all
  return all.filter((t) => t.name.toLowerCase().startsWith(q))
}
