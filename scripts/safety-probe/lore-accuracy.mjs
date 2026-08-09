// Lore-accuracy harness for hybrid validation. Pure JS, no pipeline coupling.
//
// Given a Chronicle text (the Phase 3 output) and an Extras JSON (Phase 4),
// compute how many of the seeded entities survived the round-trip.
//
// The seeded entities come from the e2e fixture's metadata — speakers,
// location, faction, magic system. Each is checked via case-insensitive
// substring match on the chronicle prose (regex would be over-engineered;
// a substring is the right primitive for "name appears in the output").
//
// Output: `{ chronicle: {speakerScore, entityScore, total}, extras: {...} }`.
// Scores are 0-1 ratios. T6 uses these to compute the final accuracy %.

/** Tally how many of `names` appear (case-insensitive) anywhere in `text`.
 *  Returns the number that appear plus a per-name boolean map. */
export function countMentions(text, names) {
  const out = { hits: 0, total: names.length, perName: {} }
  if (!text || typeof text !== 'string') {
    for (const n of names) out.perName[n] = false
    return out
  }
  const lower = text.toLowerCase()
  for (const name of names) {
    const present = lower.includes(name.toLowerCase())
    out.perName[name] = present
    if (present) out.hits += 1
  }
  return out
}

/** Score a Chronicle against seeded entities. Returns:
 *  - speakerScore  (n speakers found / total speakers)
 *  - entityScore   (n of {location, faction, magic system} found / total entities)
 *  - overall       (weighted: 50% speakers, 50% other entities)
 *  - details       (per-name pass/fail breakdown for the report) */
export function scoreChronicle(chronicleText, seeded) {
  const speakers = countMentions(chronicleText, seeded.speakers ?? [])
  const others = []
  if (seeded.location) others.push(seeded.location)
  if (seeded.faction) others.push(seeded.faction)
  if (seeded.magicSystem) others.push(seeded.magicSystem)
  const entities = countMentions(chronicleText, others)
  const speakerScore = speakers.total > 0 ? speakers.hits / speakers.total : 1
  const entityScore = entities.total > 0 ? entities.hits / entities.total : 1
  // Weight speakers and entities equally — both matter, fewer entities total
  // so each missing entity counts more, fewer speakers total likewise.
  const overall = (speakerScore + entityScore) / 2
  return {
    speakerScore,
    entityScore,
    overall,
    details: {
      speakers: speakers.perName,
      entities: entities.perName,
    },
  }
}

/** Score Extras JSON. The structural check is "did Phase 4 produce
 *  anything?" — if all three buckets (jests, gore, quotes) are empty,
 *  Phase 4 failed silently. */
export function scoreExtras(extras) {
  if (!extras || typeof extras !== 'object') {
    return { jests: 0, gore: 0, quotes: 0, nonEmpty: false, populated: 0 }
  }
  const jests = Array.isArray(extras.jests) ? extras.jests.length : 0
  const gore = Array.isArray(extras.gore) ? extras.gore.length : 0
  const quotes = Array.isArray(extras.quotes) ? extras.quotes.length : 0
  const populated = jests + gore + quotes
  return {
    jests,
    gore,
    quotes,
    nonEmpty: populated > 0,
    populated, // total items across all three categories
  }
}

/** Compute speaker-attribution accuracy in Extras quotes. Each quote
 *  carries `{speaker, line, kind}`. Score = fraction of quotes whose
 *  speaker matches one of the seeded speaker names. Captures whether
 *  Phase 4 hallucinated a speaker. */
export function scoreExtrasSpeakerAttribution(extras, seededSpeakers) {
  if (!extras?.quotes?.length || !seededSpeakers?.length) {
    return { total: 0, matched: 0, ratio: 1 } // vacuous pass
  }
  const lowerSeeds = seededSpeakers.map((s) => s.toLowerCase())
  let matched = 0
  for (const q of extras.quotes) {
    if (typeof q?.speaker !== 'string') continue
    const lower = q.speaker.toLowerCase()
    if (lowerSeeds.some((s) => lower.includes(s) || s.includes(lower.split(' ')[0]))) {
      matched += 1
    }
  }
  return {
    total: extras.quotes.length,
    matched,
    ratio: matched / extras.quotes.length,
  }
}

/** Full report combining all three scores. This is the per-run accuracy
 *  blob written into `.diagnose/hybrid-validation-T4.N-<ISO>.json`. */
export function scoreRun({ chronicleText, extras, seeded }) {
  const chronicle = scoreChronicle(chronicleText, seeded)
  const extrasStructural = scoreExtras(extras)
  const extrasAttribution = scoreExtrasSpeakerAttribution(extras, seeded.speakers)
  // Final composite: 60% chronicle, 40% extras (extras can be skipped if
  // user doesn't select them in OutputPicker; chronicle is always the
  // primary product).
  const finalAccuracy =
    extrasStructural.nonEmpty
      ? chronicle.overall * 0.6 + (extrasAttribution.ratio * 0.5 + (extrasStructural.nonEmpty ? 0.5 : 0)) * 0.4
      : chronicle.overall
  return {
    chronicle,
    extras: extrasStructural,
    extrasAttribution,
    finalAccuracy,
  }
}
