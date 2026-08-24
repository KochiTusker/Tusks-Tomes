// Codex's first configuration surface. Until now the CLI existed in the
// app only as a routing option that appeared when detected — a user whose
// codex wasn't signed in had nowhere to learn why it was missing. The
// ConnectionRow that hosts this panel carries the live status; this body
// explains what the connection is and what it is used for.

export function CodexPanel() {
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>
        Uses your own locally-installed OpenAI Codex CLI (ChatGPT Plus/Pro) as a provider —
        no API key, runs bill against the subscription you already pay for. The app never
        handles the login.
      </p>
      <p>
        Once connected, Codex appears as a subscription option in the plans above and in the
        per-phase pickers, exactly like Claude Code. If a usage window runs out mid-run, the
        run pauses itself and resumes at the exact chunk it stopped on.
      </p>
      <p className="rounded-md border border-border bg-muted/30 p-2 text-xs">
        Setup: <code>npm i -g @openai/codex</code>, then <code>codex login</code>, then press
        the refresh arrow on this row. Make sure <code>OPENAI_API_KEY</code> is not set in the
        environment — it would override the subscription.
      </p>
    </div>
  )
}
