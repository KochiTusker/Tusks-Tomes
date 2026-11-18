/** What an upstream does with a prompt once it has it. */
export interface ProviderPolicy {
  name: string
  /** May train on prompts. */
  trains: boolean
  /** Stores prompts beyond the request. */
  retains: boolean
  /** Days retained, when the provider states a figure. */
  retentionDays: number | null
}

/** Where the model list came from and how current it is. Sent with the list so
 *  the settings strip can say so without a second request. */
export interface CatalogueStatus {
  /** Host the list is fetched from. */
  source: string
  /** Whether the server may refresh the list without being asked. */
  autoUpdate: boolean
  /** The newest attempt failed, or the saved copy is older than a day. */
  stale: boolean
  /** Last time the server tried to reach OpenRouter since it started. */
  lastAttemptAt: string | null
  lastError: string | null
}
