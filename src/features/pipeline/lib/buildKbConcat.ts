import type { KBDocument } from '@/features/pipeline/lib/types'

// Strip the YAML frontmatter block (the `---\n…\n---\n` fence at the top)
// from a markdown doc. Frontmatter is structured metadata for the alias
// index — the AI doesn't need to see it in the KB body, and shipping it
// costs ~3.5% more input tokens per call for no improvement in chronicle
// quality. The alias index lives in `.tusks-lore.index.json` and is the
// canonical consumer of the metadata.
const FRONTMATTER_FENCE_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n+/

function stripFrontmatterFromDoc(text: string): string {
  return text.replace(FRONTMATTER_FENCE_RE, '')
}

export function buildKbConcat(docs: KBDocument[]): string {
  return docs
    .map((d) => `### ${d.name}\n${stripFrontmatterFromDoc(d.text)}`.trim())
    .join('\n\n---\n\n')
}
