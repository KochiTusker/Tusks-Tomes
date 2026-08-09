// Hand-crafted probe fixtures (ROADMAP Step 14). Two tests:
//
//   1. Structured JSON adherence — 5 short prompts requiring strict-JSON
//      replies matching a schema. Score = fraction parseable + on-schema.
//   2. Grounding fidelity — a 200-word transcript snippet with 5 known
//      mishearings and a glossary of 10 canonical names (the 5 targets +
//      5 distractors). Score = corrected/5 − 0.2·invented.
//
// Fixtures are intentionally short so a probe finishes in well under a
// minute on a consumer GPU. Update with care — re-probing after a change
// will mark old results inconsistent.

export type JsonFixture = {
  id: string
  schemaDescription: string
  expected: Record<string, string | number>
  prompt: string
}

export const JSON_FIXTURES: JsonFixture[] = [
  {
    id: 'json-1',
    schemaDescription: '{ "city": string, "country": string, "population": number }',
    expected: { city: 'Paris', country: 'France', population: 2161000 },
    prompt:
      'You must reply with ONLY valid JSON matching this schema and no other text:\n' +
      '{ "city": string, "country": string, "population": number }\n\n' +
      'Question: Where is the Eiffel Tower located? What is the city population (approximate, current)?',
  },
  {
    id: 'json-2',
    schemaDescription: '{ "name": string, "year": number }',
    expected: { name: 'Apollo 11', year: 1969 },
    prompt:
      'You must reply with ONLY valid JSON matching this schema and no other text:\n' +
      '{ "name": string, "year": number }\n\n' +
      'Question: Which mission first landed humans on the Moon, and in what year?',
  },
  {
    id: 'json-3',
    schemaDescription: '{ "title": string, "author": string, "pages": number }',
    expected: { title: 'The Hobbit', author: 'J.R.R. Tolkien', pages: 310 },
    prompt:
      'You must reply with ONLY valid JSON matching this schema and no other text:\n' +
      '{ "title": string, "author": string, "pages": number }\n\n' +
      'Question: Describe the novel "The Hobbit" by its author and approximate page count.',
  },
  {
    id: 'json-4',
    schemaDescription: '{ "element": string, "symbol": string, "atomic_number": number }',
    expected: { element: 'Oxygen', symbol: 'O', atomic_number: 8 },
    prompt:
      'You must reply with ONLY valid JSON matching this schema and no other text:\n' +
      '{ "element": string, "symbol": string, "atomic_number": number }\n\n' +
      'Question: Provide details for the chemical element oxygen.',
  },
  {
    id: 'json-5',
    schemaDescription: '{ "name": string, "lang": string, "first_release_year": number }',
    expected: { name: 'TypeScript', lang: 'TypeScript', first_release_year: 2012 },
    prompt:
      'You must reply with ONLY valid JSON matching this schema and no other text:\n' +
      '{ "name": string, "lang": string, "first_release_year": number }\n\n' +
      'Question: Describe the TypeScript programming language.',
  },
]

export type GroundingFixture = {
  glossary: string[]
  mishearings: Array<{ wrong: string; right: string }>
  raw: string
}

export const GROUNDING_FIXTURE: GroundingFixture = {
  glossary: [
    'Bilal',
    'Az',
    'Yannick',
    'Niamh',
    'Merr',
    'Bahamut',
    'Waterdeep',
    // Distractors
    'Tiamat',
    'Mordenkainen',
    'Cormyr',
  ],
  mishearings: [
    { wrong: 'Liara', right: 'Bilal' },
    { wrong: 'as he', right: 'Az he' },
    { wrong: 'Broady', right: 'Yannick' },
    { wrong: 'Buggo', right: 'Niamh' },
    { wrong: 'Bahamoot', right: 'Bahamut' },
  ],
  // ~200 words. Each mishearing appears once. Some real "as" usages appear
  // (those must NOT be replaced) so an over-eager model loses points.
  raw: [
    'Liara stepped onto the cobblestones, eyes sharp as the rain began to fall. ',
    'She lifted her chin and waited as the crowd parted. Behind her, Broady ',
    'sheathed his blade with a quiet click. He had come a long way, and Buggo ',
    'still owed him a drink. The temple loomed above them; Bahamoot\'s sigil ',
    'flickered in the lamplight. "We move at dusk," she said, "and not before." ',
    'Buggo nodded, though his hands trembled. Across the square, a hooded figure ',
    'watched them — as quiet as a held breath. "as he turns north, follow," ',
    'whispered Liara, and Broady understood. The procession resumed. ',
    'Above the city, ravens circled. The plan was simple, the danger was not. ',
    'They would meet again at the inn. For now, the streets demanded silence, ',
    'and silence they kept, until the bells of Waterdeep called the third hour.',
  ].join(''),
}
