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
  Scroll,
  FolderTree,
} from 'lucide-react'
import { VaultSummaryCard } from '@/components/VaultSummaryCard'
import { LoreMigrationCard } from '@/components/LoreMigrationCard'
import { ProviderSettings } from '@/components/ProviderSettings'
import { DiagnosticsCard } from '@/components/DiagnosticsCard'
import { ThinkingBudgetCard } from '@/components/ThinkingBudgetCard'
import { PipelineTuningCard } from '@/components/PipelineTuningCard'
import { isSbv, sbvToText } from '@/lib/sbv'
import { DevTestModeCard } from '@/components/DevTestModeCard'
import { ActiveProviderCard } from '@/components/ActiveProviderCard'
import { LocalLLMPanel } from '@/components/LocalLLMPanel'
import { ClaudeCodePanel } from '@/components/ClaudeCodePanel'
import { WhisperCppPanel } from '@/components/WhisperCppPanel'
import { ObsidianVaultSettings } from '@/components/ObsidianVaultSettings'
import { SavedChroniclesPanel } from '@/components/SavedChroniclesPanel'
import { ReforgePanel } from '@/components/ReforgePanel'
import { WhisperSettings } from '@/components/WhisperSettings'
import { HybridRoutingEditor } from '@/components/HybridRoutingEditor'
import { SWITCH_TAB_EVENT } from '@/components/ActiveProviderBanner'
import { UpdaterCard } from '@/components/UpdaterCard'
import { VaultPairCard } from '@/components/VaultPairCard'
import { RefinementTool } from '@/components/RefinementTool'
import { PersonaPicker } from '@/components/PersonaPicker'
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
import { getProviderSettings, isLocalProvider, setProviderSettings } from '@/lib/providers/settings'
import { STORAGE_QUOTA_EVENT, dumpAllAsJson, safeGet, safeSet } from '@/lib/storage'
import { LS_REFINEMENT } from '@/lib/constants'
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
  {
    id: 'lore-chronicles',
    title: 'Saved chronicles',
    blurb: 'Chronicles you have already produced, and re-forging them.',
    icon: <Scroll className="h-4 w-4" />,
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
    title: 'Narration',
    blurb: 'The voice your chronicle is written in.',
    icon: <BookMarked className="h-4 w-4" />,
  },
  {
    id: 'addons',
    title: 'Add-ons',
    blurb: 'Optional features — audio transcription, local models, Codex.',
    icon: <Puzzle className="h-4 w-4" />,
  },
  {
    id: 'maintenance',
    title: 'Maintenance',
    blurb: 'Updates, diagnostics, and developer tools.',
    icon: <Wrench className="h-4 w-4" />,
  },
]

export const LOAD_TRANSCRIPT_EVENT = 'sbts:load-transcript'

export default function App() {
  const [activeTab, setActiveTab] = useState<string>('refinement')
  const [setupWizardOpen, setSetupWizardOpen] = useState(false)
  const { isLoaded } = useAddons()
  const audioLoaded = isLoaded('audio-addon')
  const localLlmLoaded = isLoaded('local-llm-addon')
  const claudeCodeLoaded = isLoaded('claude-code-addon')
  const whisperCppLoaded = isLoaded('whisper-cpp-addon')

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
  const personasLoaded = isLoaded('personas-addon')
  const obsidianLoaded = isLoaded('obsidian-vault-addon')

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
            label: 'Download backup',
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
      if (detail?.tab) setActiveTab(detail.tab)
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
    window.addEventListener('sbts:open-personas', handleOpenPersonas)
    return () => {
      window.removeEventListener(STORAGE_QUOTA_EVENT, handleQuota)
      window.removeEventListener(LOAD_TRANSCRIPT_EVENT, handleLoadTranscript)
      window.removeEventListener('sbts:open-doc', handleOpenDoc)
      window.removeEventListener(SWITCH_TAB_EVENT, handleSwitchTab)
      window.removeEventListener('sbts:open-personas', handleOpenPersonas)
    }
  }, [])

  // If the active tab becomes hidden (add-on routes not loaded — either
  // uninstalled, or installed but pending a server restart), fall back.
  useEffect(() => {
    if (!audioLoaded && (activeTab === 'upload' || activeTab === 'sessions')) {
      setActiveTab('refinement')
    }
  }, [audioLoaded, activeTab])

  // Cloud fallback for the local-llm-addon: if a user had a local providerId
  // saved (ollama/lmstudio/unsloth) but the add-on isn't loaded in this
  // process, the pipeline would 404 trying to reach /api/local/*. Reset to
  // gemini once on boot and surface a toast so they know what happened.
  useEffect(() => {
    const settings = getProviderSettings()
    if (!localLlmLoaded && isLocalProvider(settings.providerId)) {
      setProviderSettings({ ...settings, providerId: 'gemini' })
      toast.info(
        'Switched to Gemini — the Local LLMs add-on is not enabled. Install it from Settings → Add-ons to use Ollama / LM Studio / Unsloth.',
        { duration: 10000 },
      )
    }
  }, [localLlmLoaded])

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
          <TabsList className="bg-card/60 border border-border">
            <TabsTrigger value="refinement" className="font-display tracking-wider uppercase">
              Chronicle
            </TabsTrigger>
            <TabsTrigger value="captions" className="font-display tracking-wider uppercase">
              Caption Repair
            </TabsTrigger>
            <TabsTrigger value="kb" className="font-display tracking-wider uppercase">
              Tome of Lore
            </TabsTrigger>
            {audioLoaded && (
              <TabsTrigger value="upload" className="font-display tracking-wider uppercase">
                Upload
              </TabsTrigger>
            )}
            {audioLoaded && (
              <TabsTrigger value="sessions" className="font-display tracking-wider uppercase">
                Sessions
              </TabsTrigger>
            )}
            <TabsTrigger value="settings" className="font-display tracking-wider uppercase">
              Settings
            </TabsTrigger>
            <TabsTrigger value="help" className="font-display tracking-wider uppercase">
              Help
            </TabsTrigger>
            <TabsTrigger value="about" className="font-display tracking-wider uppercase">
              About
            </TabsTrigger>
          </TabsList>
          <TabsContent value="refinement" className="space-y-4">
            <PersonaPicker />
            <RefinementTool />
          </TabsContent>
          <TabsContent value="captions">
            <CaptionRepair />
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
                  itemCount={obsidianLoaded ? 5 : 4}
                >
                  <LoreSourceCard />
                  {obsidianLoaded && <ObsidianVaultSettings />}
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

                <PageSection {...LORE_SECTIONS[2]} itemCount={2}>
                  <SavedChroniclesPanel />
                  <ReforgePanel />
                </PageSection>
              </div>
            </div>
          </TabsContent>
          {audioLoaded && (
            <TabsContent value="upload" className="space-y-4">
              <UploadPanel />
            </TabsContent>
          )}
          {audioLoaded && (
            <TabsContent value="sessions" className="space-y-4">
              <SessionsList onSendToRefinement={handleSendToRefinement} />
            </TabsContent>
          )}
          <TabsContent value="settings">
            <div className="flex gap-6">
              <PageSectionNav sections={SETTINGS_SECTIONS} />
              <div className="min-w-0 flex-1 space-y-3">
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
                <PageSection {...SETTINGS_SECTIONS[0]} itemCount={4}>
                  {/* Linear flow: keys → active key → per-phase models +
                      overrides. Model Profiles now lives INSIDE the routing
                      editor's advanced view, so one screen owns every
                      "which model runs this phase" decision. */}
                  <ProviderSettings />
                  <ActiveProviderCard />
                  {localLlmLoaded && <LocalLLMPanel />}
                  {claudeCodeLoaded && <ClaudeCodePanel />}
                  {whisperCppLoaded && <WhisperCppPanel />}
                  <HybridRoutingEditor />
                </PageSection>

                <PageSection {...SETTINGS_SECTIONS[1]} itemCount={2}>
                  <ThinkingBudgetCard />
                  <PipelineTuningCard />
                </PageSection>

                {personasLoaded && (
                  <PageSection {...SETTINGS_SECTIONS[2]} itemCount={1}>
                    <PersonasManager />
                  </PageSection>
                )}

                <PageSection {...SETTINGS_SECTIONS[3]} itemCount={audioLoaded ? 2 : 1}>
                  <AddonsManager />
                  {audioLoaded && <WhisperSettings />}
                </PageSection>

                <PageSection {...SETTINGS_SECTIONS[4]} itemCount={devModeUnlocked ? 3 : 2}>
                  <UpdaterCard devModeUnlocked={devModeUnlocked} />
                  {devModeUnlocked && <DevTestModeCard />}
                  <DiagnosticsCard />
                </PageSection>
              </div>
            </div>
          </TabsContent>
          <TabsContent value="help">
            <DocsViewer />
          </TabsContent>
          <TabsContent value="about">
            <AboutPage />
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
