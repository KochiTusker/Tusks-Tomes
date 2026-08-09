#!/usr/bin/env node
// Bulk-transform every user-facing .md file in a repo so that each top-level
// H2 (`## Heading`) starts a collapsible `<details><summary><h2>...</h2></summary>
// <div class="docs-section-body">...</div></details>` block. GitHub renders
// these natively as click-to-expand sections; the in-app docs viewer
// (src/components/DocsViewer.tsx + src/lib/collapsibleMarkdown.ts) styles
// them as cards.
//
// Idempotent: if a file already contains a <details> element we leave it
// alone. Headings inside fenced code blocks are NOT split (we track ``` fences).
//
// Usage:
//   node scripts/wrap-md-sections.mjs <repo-root>
//
// If <repo-root> is omitted, defaults to process.cwd().

import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT_LEVEL_DOCS = [
  'README.md',
  'CONTRIBUTING.md',
  'ROADMAP.md',
  'SETUP.md',
  'SECURITY.md',
  'CODE_OF_CONDUCT.md',
  'architecture.md',
];

const FENCE_RE = /^```/;
const DETAILS_RE = /<details[\s>]/i;

function wrapH2SectionsInDetails(md) {
  if (DETAILS_RE.test(md)) return { content: md, changed: false, reason: 'already-has-details' };

  const lines = md.split('\n');
  const out = [];
  let inFence = false;
  let sectionDepth = 0;
  let sectionsWrapped = 0;

  const closeSection = () => {
    if (sectionDepth > 0) {
      out.push('', '</div>', '</details>', '');
      sectionDepth = 0;
    }
  };

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    const h2 = !inFence && line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      closeSection();
      const heading = h2[1].replace(/</g, '&lt;').replace(/>/g, '&gt;');
      out.push('<details class="docs-section">');
      out.push(`<summary><h2>${heading}</h2></summary>`);
      out.push('<div class="docs-section-body">');
      out.push('');
      sectionDepth = 1;
      sectionsWrapped += 1;
    } else {
      out.push(line);
    }
  }
  closeSection();
  return {
    content: out.join('\n'),
    changed: sectionsWrapped > 0,
    reason: sectionsWrapped > 0 ? `wrapped ${sectionsWrapped}` : 'no h2 headings',
  };
}

async function walkMdFiles(dir, relBase) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'dist-server' || entry.name.startsWith('.')) {
      continue;
    }
    const abs = path.join(dir, entry.name);
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await walkMdFiles(abs, rel)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push({ abs, rel });
    }
  }
  return out;
}

async function main() {
  const repoRoot = path.resolve(process.argv[2] ?? process.cwd());
  console.log(`[wrap-md-sections] repo root: ${repoRoot}`);

  const targets = [];

  // Root-level docs (only the ones we want surfaced — exclude CLAUDE.md etc).
  for (const name of ROOT_LEVEL_DOCS) {
    try {
      await fs.access(path.join(repoRoot, name));
      targets.push({ abs: path.join(repoRoot, name), rel: name });
    } catch {
      // skip missing
    }
  }

  // Everything under docs/ regardless of name.
  const docsDir = path.join(repoRoot, 'docs');
  targets.push(...(await walkMdFiles(docsDir, 'docs')));

  console.log(`[wrap-md-sections] found ${targets.length} markdown files`);

  let touched = 0;
  let skipped = 0;
  for (const { abs, rel } of targets) {
    const original = await fs.readFile(abs, 'utf8');
    const { content, changed, reason } = wrapH2SectionsInDetails(original);
    if (changed) {
      await fs.writeFile(abs, content, 'utf8');
      touched += 1;
      console.log(`  ✓ ${rel} — ${reason}`);
    } else {
      skipped += 1;
      console.log(`  · ${rel} — skipped (${reason})`);
    }
  }
  console.log(`[wrap-md-sections] touched ${touched}, skipped ${skipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
