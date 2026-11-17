// The speaker-name mapping, as stored and as sent over /api/speakers.

export type Speaker = {
  discordUserId: string
  discordDisplayName?: string
  playerName: string
  characterName: string
}

export type SpeakersDocument = {
  version: 1
  speakers: Speaker[]
}
