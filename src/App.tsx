import { useEffect, useRef, useState } from 'react'
import { Toaster, toast } from 'sonner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { BuyMeACoffeeButton } from '@/components/BuyMeACoffeeButton'
import { FeedbackButton } from '@/components/FeedbackButton'
import { Button } from '@/components/ui/button'
import { RecommendedSetupWizard } from '@/components/RecommendedSetupWizard'
import { Header } from '@/components/Header'
import { CaptionRepair } from '@/components/CaptionRepair'
import { UploadPanel } from '@/components/UploadPanel'
import { GlossaryEditor } from '@/components/GlossaryEditor'
import { GuardrailsCard } from '@/components/GuardrailsCard'
import { KnowledgeBaseManager } from '@/components/KnowledgeBaseManager'
import { LoreSourceCard } from '@/components/LoreSourceCard'
import {
  PageSection,
  PageSectionNav,
  type PageSectionDef,
} from '@/components/PageSection'
import {
  KeyRound,
  Wand2,
  Puzzle,
  BookMarked,
  Wrench,
  Library,
  SpellCheck,
  Search,
  FolderTree,
} from 'lucide-react'
import { VaultSummaryCard } from '@/components/VaultSummaryCard'
import { LoreMigrationCard } from '@/components/LoreMigrationCard'
import { ProviderSettings } from '@/components/ProviderSettings'
import { DiagnosticsCard } from '@/components/DiagnosticsCard'
import { PipelineTuningCard } from '@/components/PipelineTuningCard'
import { OpenRouterModelPicker } from '@/components/OpenRouterModelPicker'
import { getProvidersSummary } from '@/lib/providerSettings'
import { listConfiguredCloudKeyOptions, optionFromRouting } from '@/lib/cloudKeys'
import { getRouting } from '@/lib/routing'
import { isSbv, sbvToText } from '@/lib/sbv'
import { DevTestModeCard } from '@/components/DevTestModeCard'
import { LocalLLMPanel } from '@/components/LocalLLMPanel'
import { ConnectionRow } from '@/components/ConnectionRow'
import { CodexPanel } from '@/components/CodexPanel'
import { probeClaudeCode, probeCodex, probeLocalRunners, probeWhisperCpp } from '@/lib/connections'
import { ClaudeCodePanel } from '@/components/ClaudeCodePanel'
import { WhisperCppPanel } from '@/components/WhisperCppPanel'
import { ObsidianVaultSettings } from '@/components/ObsidianVaultSettings'
import { SavedChroniclesPanel } from '@/components/SavedChroniclesPanel'
import { ReforgePanel } from '@/components/ReforgePanel'
import { WhisperSettings } from '@/components/WhisperSettings'
import { HybridRoutingEditor } from '@/components/HybridRoutingEditor'
import { ACTIVE_PROVIDER_CHANGED_EVENT, OPEN_SETUP_WIZARD_EVENT, SWITCH_TAB_EVENT } from '@/lib/appEvents'
import { UpdaterCard } from '@/components/UpdaterCard'
import { VaultPairCard } from '@/components/VaultPairCard'
import { RefinementTool } from '@/components/RefinementTool'
import { PersonasManager } from '@/components/PersonasManager'
import { SessionsList } from '@/components/SessionsList'
import { SpeakerEditor } from '@/components/SpeakerEditor'
import { AddonsManager } from '@/components/AddonsManager'
import { DocsViewer } from '@/components/DocsViewer'
import { AboutPage } from '@/components/AboutPage'
import { LoreCard } from '@/components/LoreCard'
import { ArcaneSigil } from '@/components/ArcaneSigil'
import { useAddons } from '@/contexts/AddonContext'
import { useLoreDocuments } from '@/hooks/useLoreDocuments'
import { STORAGE_QUOTA_EVENT, dumpAllAsJson, safeGet, safeSet } from '@/lib/storage'
import { LS_REFINEMENT } from '@/lib/constants'
import { resolveTabValue } from '@/lib/tabs'
import { transitionOrJustDo, type TransitionCapableDocument } from '@/lib/viewTransition'
import { initialRefinementState, type RefinementState } from '@/types'

/** Tome of Lore groups. Ordered as a newcomer meets them: where lore comes
 *  FROM, then what lore you HAVE, then the corrections applied to
 *  transcripts, then the chronicles already produced. Only the first is open
 *  on a first visit — the tab was 11 always-open cards, ~3,600 lines of UI,
 *  in one flat stack. */
const LORE_SECTIONS: PageSectionDef[] = [
  {
    id: 'lore-source',
    title: 'Lore source',
    blurb: 'Where your canon is read from, and the notes it contains.',
    icon: <FolderTree className="h-4 w-4" />,
    // Setup, not routine: you choose a source once and rarely revisit it.
    // Collapsed by default, but its summary carries a live status chip so
    // the closed state still answers "what am I grounding against?".
  },
  {
    id: 'lore-corrections',
    title: 'Names & corrections',
    blurb: 'Fix names transcription mishears, and map speakers to characters.',
    icon: <SpellCheck className="h-4 w-4" />,
    // The one thing here edited session to session — a misheard name is
    // fixed permanently by a glossary entry, so this is the tab's real
    // day-to-day surface. Open on arrival.
    defaultOpen: true,
  },
]

/** Nested inside Lore source — the notes belong WITH the source that
 *  supplies them, rather than as a sibling you had to mentally connect. */
const LORE_LIBRARY_SECTION: PageSectionDef = {
  id: 'lore-library',
  title: 'Lore library',
  blurb: 'The notes and documents the AI grounds your chronicle against.',
  icon: <Library className="h-4 w-4" />,
}

/** Settings groups, in the order they appear. Ordered by frequency of use:
 *  Providers is what you set up first and return to; Maintenance is rare and
 *  used to occupy the top of the page with update warnings. */
const SETTINGS_SECTIONS: PageSectionDef[] = [
  {
    id: 'providers',
    title: 'Providers & models',
    blurb: 'API keys, which provider runs, and what model handles each phase.',
    icon: <KeyRound className="h-4 w-4" />,
    defaultOpen: true,
  },
  {
    id: 'tuning',
    title: 'Pipeline tuning',
    blurb: 'Optional quality and cost adjustments. All default to off.',
    icon: <Wand2 className="h-4 w-4" />,
  },
  {
    id: 'narration',
    title: 'Voice & content',
    blurb: 'The voice your chronicle is written in, and what the models may filter.',
    icon: <BookMarked className="h-4 w-4" />,
  },
  {
    id: 'addons',
    title: 'Transcription',
    blurb: 'Turning recorded audio into a transcript — the one feature that installs.',
    icon: <Puzzle className="h-4 w-4" />,
  },
  {
    id: 'maintenance',
    title: 'Maintenance',
    blurb: 'Updates, diagnostics, and developer tools.',
    icon: <Wrench className="h-4 w-4" />,
  },
]

/** What the settings search matches, per section — title and blurb are
 *  always included; these are the extra words people actually type. */
const SETTINGS_KEYWORDS: Record<string, string> = {
  providers:
    'api key gemini openrouter claude code codex model models plan preset routing phase ' +
    'local ollama lm studio unsloth runner probe catalogue browse free paid tier',
  tuning: 'cost quality lore condense quotes alias hints retrieval tuning cheaper',
  narration:
    'persona narrator voice bard guardrails filter content mature safety harassment explicit',
  addons: 'whisper transcription audio install python gpu nvidia cpp bridge upload craig',
  maintenance: 'update updater diagnostics logs version developer restart',
}

export const LOAD_TRANSCRIPT_EVENT = 'sbts:load-transcript'

export default function App() {
  const [activeTab, setActiveTabRaw] = useState<string>('refinement')
  // Cross-fade tab switches where the platform can (View Transitions API,
  // feature-detected) and the user hasn't asked for reduced motion. Falls
  // through to an instant switch everywhere else — never a behaviour fork.
  const setActiveTab = (tab: string) => {
    transitionOrJustDo(
      () => setActiveTabRaw(tab),
      document as TransitionCapableDocument,
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
  }
  const [setupWizardOpen, setSetupWizardOpen] = useState(false)
  // Settings search: filters sections and force-opens matches. Query is
  // session-local by design — a filter is a moment, not a preference.
  const [settingsQuery, setSettingsQuery] = useState('')
  const settingsMatches = (id: string, title: string, blurb: string): boolean => {
    const q = settingsQuery.trim().toLowerCase()
    if (!q) return true
    const haystack = `${title} ${blurb} ${SETTINGS_KEYWORDS[id] ?? ''}`.toLowerCase()
    return q.split(/\s+/).every((word) => haystack.includes(word))
  }
  const visibleSettingsSections = SETTINGS_SECTIONS.filter((sec) =>
    settingsMatches(sec.id, sec.title, sec.blurb),
  ).length
  const { isLoaded } = useAddons()
  const audioLoaded = isLoaded('audio-addon')

  // The OpenRouter picker only appears once a key is configured. The
  // catalogue itself needs no key, but a model list is noise to someone who
  // has not opted into that provider.
  const [openrouterConfigured, setOpenrouterConfigured] = useState(false)
  // Live chip for the collapsed Providers section: a closed section that
  // still says which plan is active is worth far more than one you must
  // open to check.
  const [activeShort, setActiveShort] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    function load() {
      Promise.all([getProvidersSummary(), getRouting().catch(() => null)])
        .then(([s, r]) => {
          if (!alive) return
          setOpenrouterConfigured(s.configured.includes('openrouter'))
          const opts = listConfiguredCloudKeyOptions(s)
          const match = r ? optionFromRouting(opts, r.lastSelectedProvider, r.geminiTier) : null
          setActiveShort(match?.short ?? opts[0]?.short ?? null)
        })
        .catch(() => {
          /* Settings still render; the picker just stays hidden. */
        })
    }
    load()
    const onChange = () => load()
    window.addEventListener(ACTIVE_PROVIDER_CHANGED_EVENT, onChange)
    return () => {
      alive = false
      window.removeEventListener(ACTIVE_PROVIDER_CHANGED_EVENT, onChange)
    }
  }, [])

  // Hidden 5-tap on the coat-of-arms logo reveals the dev-mode updater
  // toggle on the UpdaterCard. Android-style. Taps only count up inside
  // a 2-second window — idle resets the counter. State is session-local
  // (closing the tab re-hides the toggle); the actual updaterRemote
  // setting persists in {configDir}/settings.json regardless.
  const [devModeUnlocked, setDevModeUnlocked] = useState(false)
  const devTapCountRef = useRef(0)
  const devTapTimerRef = useRef<number | null>(null)
  const handleSecretTap = () => {
    if (devTapTimerRef.current !== null) window.clearTimeout(devTapTimerRef.current)
    devTapCountRef.current += 1
    if (devTapCountRef.current >= 5) {
      setDevModeUnlocked((prev) => !prev)
      devTapCountRef.current = 0
    } else {
      devTapTimerRef.current = window.setTimeout(() => {
        devTapCountRef.current = 0
      }, 2000)
    }
  }

  // Active lore source drives the Tome of Lore tab: when the Obsidian vault is
  // active, the Tusks-Lore Knowledge Base manager is hidden in favour of a
  // read-only vault summary, so it's clear the folder isn't in use.
  const { source: loreSource } = useLoreDocuments()
  const obsidianActive = loreSource === 'obsidian-vault'

  useEffect(() => {
    function handleQuota(e: Event) {
      const detail = (e as CustomEvent).detail as { key: string; bytes: number } | undefined
      toast.error(
        `localStorage full when saving "${detail?.key ?? '?'}" (~${detail?.bytes ?? '?'} bytes).`,
        {
          duration: 12000,
          action: {
            label: 'Download app-state backup (browser data)',
            onClick: () => {
              const blob = new Blob([dumpAllAsJson()], { type: 'application/json' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `sbts-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
              a.click()
              URL.revokeObjectURL(url)
            },
          },
        }
      )
    }
    function handleLoadTranscript(e: Event) {
      // RefinementTool also listens for this event, but its <TabsContent>
      // unmounts when the Chronicle tab isn't active — and the Send to
      // Refinement buttons live on other tabs, so the listener doesn't
      // exist at the moment the event fires. Persist the transcript to
      // LS_REFINEMENT directly so RefinementTool picks it up via its
      // useLocalStorage initializer the instant it mounts.
      const detail = (e as CustomEvent).detail as { text?: string } | undefined
      if (detail?.text) {
        // Sessions / Upload hand off the raw .sbv, timestamp lines and all.
        // TranscriptInput converts on the file-load path; this listener has to
        // do the same or Phase 1 grounds 4,096 timestamp lines it must then
        // preserve, carrying them into every downstream phase. Measured on
        // Session 29: ~56% of Phase 3's input tokens were timestamps.
        const incoming = isSbv(detail.text) ? sbvToText(detail.text) : detail.text
        const current = safeGet<RefinementState>(LS_REFINEMENT, initialRefinementState)
        safeSet(LS_REFINEMENT, {
          ...current,
          rawTranscript: incoming,
          updatedAt: new Date().toISOString(),
        })
      }
      setActiveTab('refinement')
    }
    // When another component (AddonsManager, WhisperSettings) deep-links
    // into a specific doc, switch to the Help tab. DocsViewer itself
    // listens for the same event and loads the requested slug.
    function handleOpenDoc() {
      setActiveTab('help')
    }
    function handleSwitchTab(e: Event) {
      const detail = (e as CustomEvent).detail as { tab?: string } | undefined
      // Legacy values (upload/about/captions) map to their new homes --
      // a dispatcher we missed lands somewhere sensible, never on a tab
      // that no longer exists.
      if (detail?.tab) setActiveTab(resolveTabValue(detail.tab))
    }
    function handleOpenWizard() {
      setSetupWizardOpen(true)
    }
    // PersonaPicker → "Manage" button fires this; we jump to Settings.
    // PersonasManager finds itself via DOM scroll after the tab switch.
    function handleOpenPersonas() {
      setActiveTab('settings')
      requestAnimationFrame(() => {
        document.getElementById('personas-manager')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }
    window.addEventListener(STORAGE_QUOTA_EVENT, handleQuota)
    window.addEventListener(LOAD_TRANSCRIPT_EVENT, handleLoadTranscript)
    window.addEventListener('sbts:open-doc', handleOpenDoc)
    window.addEventListener(SWITCH_TAB_EVENT, handleSwitchTab)
    window.addEventListener(OPEN_SETUP_WIZARD_EVENT, handleOpenWizard)
    window.addEventListener('sbts:open-personas', handleOpenPersonas)
    return () => {
      window.removeEventListener(STORAGE_QUOTA_EVENT, handleQuota)
      window.removeEventListener(LOAD_TRANSCRIPT_EVENT, handleLoadTranscript)
      window.removeEventListener('sbts:open-doc', handleOpenDoc)
      window.removeEventListener(SWITCH_TAB_EVENT, handleSwitchTab)
      window.removeEventListener(OPEN_SETUP_WIZARD_EVENT, handleOpenWizard)
      window.removeEventListener('sbts:open-personas', handleOpenPersonas)
    }
  }, [])

  // If the active tab becomes hidden (add-on routes not loaded — either
  // uninstalled, or installed but pending a server restart), fall back.
  useEffect(() => {
    if (!audioLoaded && activeTab === 'sessions') {
      setActiveTab('refinement')
    }
  }, [audioLoaded, activeTab])

  const handleSendToRefinement = (sbv: string) => {
    window.dispatchEvent(new CustomEvent(LOAD_TRANSCRIPT_EVENT, { detail: { text: sbv } }))
  }

  return (
    <div className="flex min-h-screen flex-col">
      {/* Drifting ember particles — a single fixed-position layer behind
          everything else. Pure CSS animation, ignorable to assistive tech. */}
      <div className="ember-field" aria-hidden>
        <span /><span /><span /><span /><span />
      </div>
      {/* Arcane wisps — slow-drifting "will o' wisp" orbs that meander
          across the viewport in curving paths. Three colour variants
          (amethyst default, ember, moonsilver) layered with the ember
          field so the page feels alive with magical motion rather than
          just rising sparks. mix-blend-mode: screen on .wisp-veil keeps
          them additive over the void violet background. */}
      <div className="wisp-veil" aria-hidden>
        <span />
        <span className="wisp-ember" />
        <span className="wisp-silver" />
        <span />
        <span className="wisp-ember" />
        <span className="wisp-silver" />
        <span />
      </div>
      {/* Two corner sigils that bloom in/out every ~28s. Pure-CSS reveal
          animation, ignorable to assistive tech. */}
      <ArcaneSigil corner="tl" />
      <ArcaneSigil corner="br" />
      <Header onSecretTap={handleSecretTap} />
      <main
        className={`tab-bg relative mx-auto w-full max-w-6xl flex-1 px-6 py-6`}
        data-tab={activeTab}
      >
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
          {/* The work tabs sit left, in the order the weekly loop uses
              them; Settings and Help sit apart on the right, where every
              application people already know keeps them. */}
          <TabsList className="w-full bg-card/60 border border-border">
            {audioLoaded && (
              <TabsTrigger value="sessions" className="font-display tracking-wider uppercase">
                Sessions
              </TabsTrigger>
            )}
            <TabsTrigger value="refinement" className="font-display tracking-wider uppercase">
              Chronicle
            </TabsTrigger>
            <TabsTrigger value="kb" className="font-display tracking-wider uppercase">
              Tome of Lore
            </TabsTrigger>
            <TabsTrigger value="settings" className="ml-auto font-display tracking-wider uppercase">
              Settings
            </TabsTrigger>
            <TabsTrigger value="help" className="font-display tracking-wider uppercase">
              Help
            </TabsTrigger>
          </TabsList>
          <TabsContent value="refinement" className="space-y-4">
            <RefinementTool />
            {/* Caption repair is an action on a transcript, not a
                destination: it lives with the transcript work. */}
            <details className="rounded-md border border-border bg-card/40 p-4">
              <summary className="cursor-pointer font-display text-sm uppercase tracking-wider">
                Repair a caption file
                <span className="ml-2 text-xs font-normal normal-case text-muted-foreground">
                  {'\u2014'} fix names in a YouTube .sbv and export it corrected.
                </span>
              </summary>
              <div className="reveal-on-open mt-4">
                <CaptionRepair />
              </div>
            </details>
            {/* The chronicles this tab produces live where they were made. */}
            <details className="rounded-md border border-border bg-card/40 p-4">
              <summary className="cursor-pointer font-display text-sm uppercase tracking-wider">
                Saved chronicles
                <span className="ml-2 text-xs font-normal normal-case text-muted-foreground">
                  {'\u2014'} everything produced so far, and re-forging it.
                </span>
              </summary>
              <div className="reveal-on-open mt-4 space-y-4">
                <SavedChroniclesPanel />
                <ReforgePanel />
              </div>
            </details>
          </TabsContent>
          <TabsContent value="kb">
            <div className="flex gap-6">
              <PageSectionNav sections={LORE_SECTIONS} />
              <div className="min-w-0 flex-1 space-y-3">
                {/* Lore configuration and lore CONTENT live on the same tab:
                    ObsidianVaultSettings / LoreCard / VaultPairCard used to
                    sit in Settings, which split one concern across two tabs. */}
                <PageSection
                  {...LORE_SECTIONS[0]}
                  status={obsidianActive ? 'Obsidian vault' : 'Tusks-Lore folder'}
                  itemCount={5}
                >
                  <LoreSourceCard />
                  <ObsidianVaultSettings />
                  <LoreCard />
                  <VaultPairCard />

                  {/* The library lives INSIDE its source: which notes exist
                      is a property of the source you just chose, not a
                      separate concern a level up. */}
                  <PageSection
                    {...LORE_LIBRARY_SECTION}
                    nested
                    itemCount={obsidianActive ? 1 : 2}
                  >
                    {obsidianActive ? (
                      // Obsidian is the active, read-only source — hide the
                      // Tusks-Lore KB manager and migration card (which would
                      // edit the inactive folder) in favour of a clear
                      // read-only vault summary.
                      <VaultSummaryCard />
                    ) : (
                      <>
                        <KnowledgeBaseManager />
                        <LoreMigrationCard />
                      </>
                    )}
                  </PageSection>
                </PageSection>

                <PageSection {...LORE_SECTIONS[1]} itemCount={2}>
                  <GlossaryEditor />
                  <SpeakerEditor />
                </PageSection>
              </div>
            </div>
          </TabsContent>
          {audioLoaded && (
            <TabsContent value="sessions" className="space-y-4">
              {/* Creating a session and listing sessions are one object --
                  the upload is the list's primary action, not a sibling
                  tab. */}
              <UploadPanel />
              <SessionsList onSendToRefinement={handleSendToRefinement} />
            </TabsContent>
          )}
          <TabsContent value="settings">
            <div className="flex gap-6">
              <PageSectionNav
                sections={SETTINGS_SECTIONS.filter((sec) =>
                  settingsMatches(sec.id, sec.title, sec.blurb),
                )}
              />
              <div className="min-w-0 flex-1 space-y-3">
                {/* Search first: five sections, most nested — the person
                    who knows the word they want should not have to know
                    which group it was filed under. */}
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="search"
                    aria-label="Search settings"
                    value={settingsQuery}
                    onChange={(e) => setSettingsQuery(e.target.value)}
                    placeholder="Search settings… e.g. api key, persona, whisper"
                    className="w-full rounded-md border border-border bg-card/60 py-2 pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground focus:border-primary"
                  />
                </div>
                {/* Guided setup sits ABOVE the sections, not inside one: it
                    spans providers, add-ons and routing, so filing it under
                    any single section would hide it from the people who need
                    it most — first-time users who don't yet know what the
                    sections mean. */}
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card/60 p-4">
                  <div className="min-w-0">
                    <p className="font-medium">New here? Let us set it up for you</p>
                    <p className="text-sm text-muted-foreground">
                      Walks through the configuration that works best, and shows you exactly what it will
                      change before changing anything.
                    </p>
                  </div>
                  <Button onClick={() => setSetupWizardOpen(true)}>Guided setup</Button>
                </div>

                {/* Ordered by how often you touch it, not by subsystem.
                    Providers first (the thing you set up and revisit);
                    Maintenance last (rarely, and it used to greet you with
                    two alarm-coloured panels on arrival). */}
                {settingsMatches(SETTINGS_SECTIONS[0].id, SETTINGS_SECTIONS[0].title, SETTINGS_SECTIONS[0].blurb) && (
                <PageSection {...SETTINGS_SECTIONS[0]} forceOpen={settingsQuery.trim() !== '' ? true : undefined} itemCount={5} status={activeShort ?? undefined}>
                  {/* Linear flow: keys → active key → per-phase routing. One
                      row per phase owns the whole "which model runs this"
                      decision; there is no second grid competing with it.
                      The connection panels (local runners, the two CLIs)
                      always render and report their own detected status —
                      an absent CLI is a row with a remedy, not a hidden
                      feature. */}
                  <ProviderSettings />
                  {/* The connections: one row shape for everything you
                      point the app at. Absent is a visible row with a
                      remedy, never a hidden feature. */}
                  <ConnectionRow name="Claude Code (your subscription)" experimental probe={probeClaudeCode}>
                    <ClaudeCodePanel />
                  </ConnectionRow>
                  <ConnectionRow name="Codex (your ChatGPT subscription)" experimental probe={probeCodex}>
                    <CodexPanel />
                  </ConnectionRow>
                  <ConnectionRow name="Local runners — Ollama, LM Studio, Unsloth" probe={probeLocalRunners}>
                    <LocalLLMPanel />
                  </ConnectionRow>
                  <HybridRoutingEditor />
                  {openrouterConfigured && <OpenRouterModelPicker />}
                </PageSection>
                )}

                {settingsMatches(SETTINGS_SECTIONS[1].id, SETTINGS_SECTIONS[1].title, SETTINGS_SECTIONS[1].blurb) && (
                <PageSection {...SETTINGS_SECTIONS[1]} forceOpen={settingsQuery.trim() !== '' ? true : undefined} itemCount={1}>
                  <PipelineTuningCard />
                </PageSection>
                )}

                {settingsMatches(SETTINGS_SECTIONS[2].id, SETTINGS_SECTIONS[2].title, SETTINGS_SECTIONS[2].blurb) && (
                <PageSection {...SETTINGS_SECTIONS[2]} forceOpen={settingsQuery.trim() !== '' ? true : undefined} itemCount={2}>
                  <PersonasManager />
                  {/* Content-filter categories were previously reached from
                      inside the provider card — a beginner picking a key
                      shouldn't meet safety toggles on the way. They live
                      with voice now: both decide what the prose may say. */}
                  <GuardrailsCard />
                </PageSection>
                )}

                {settingsMatches(SETTINGS_SECTIONS[3].id, SETTINGS_SECTIONS[3].title, SETTINGS_SECTIONS[3].blurb) && (
                <PageSection {...SETTINGS_SECTIONS[3]} forceOpen={settingsQuery.trim() !== '' ? true : undefined} itemCount={audioLoaded ? 3 : 2} status={audioLoaded ? 'Installed' : 'Not installed'}>
                  <AddonsManager />
                  {audioLoaded && <WhisperSettings />}
                  <ConnectionRow name="whisper.cpp bridge (your own build)" experimental probe={probeWhisperCpp}>
                    <WhisperCppPanel />
                  </ConnectionRow>
                </PageSection>
                )}

                {settingsMatches(SETTINGS_SECTIONS[4].id, SETTINGS_SECTIONS[4].title, SETTINGS_SECTIONS[4].blurb) && (
                <PageSection {...SETTINGS_SECTIONS[4]} forceOpen={settingsQuery.trim() !== '' ? true : undefined} itemCount={devModeUnlocked ? 3 : 2}>
                  <UpdaterCard devModeUnlocked={devModeUnlocked} />
                  {devModeUnlocked && <DevTestModeCard />}
                  <DiagnosticsCard />
                </PageSection>
                )}

                {visibleSettingsSections === 0 && (
                  <div className="rounded-lg border border-border/70 bg-card/30 p-6 text-center">
                    <p className="font-medium">Nothing matches “{settingsQuery.trim()}”</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Try a plainer word — “key”, “model”, “voice”, “whisper”, “update”.
                    </p>
                    <button
                      type="button"
                      onClick={() => setSettingsQuery('')}
                      className="mt-3 text-sm font-medium text-primary underline-offset-2 hover:underline"
                    >
                      Clear the search
                    </button>
                  </div>
                )}
              </div>
            </div>
          </TabsContent>
          <TabsContent value="help" className="space-y-4">
            <DocsViewer />
            <details className="rounded-md border border-border bg-card/40 p-4">
              <summary className="cursor-pointer font-display text-sm uppercase tracking-wider">
                About Tusk's Tomes
              </summary>
              <div className="reveal-on-open mt-4">
                <AboutPage />
              </div>
            </details>
          </TabsContent>
        </Tabs>
      </main>
      {/* Floating BMAC + feedback pills — both mounted at the app root so
          they persist across every tab. Feedback sits above BMAC in the
          bottom-right stack; BMAC keeps its sister-project parity slot. */}
      <FeedbackButton />
      <BuyMeACoffeeButton />
      {/* Mounted at the app root, not inside the Settings tab: the wizard
          restarts its own state on open, and keeping it here means a future
          entry point (first-run prompt, help menu) can open it from anywhere. */}
      <RecommendedSetupWizard open={setupWizardOpen} onOpenChange={setSetupWizardOpen} />
      <Toaster position="top-right" richColors closeButton theme="dark" />
    </div>
  )
}
