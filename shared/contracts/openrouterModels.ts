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
