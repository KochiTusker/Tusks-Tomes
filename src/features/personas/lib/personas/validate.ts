import { validatePersona as validate, type PersonaValidationError } from '@shared/personas/validate'
import type { Persona } from '@shared/personas/types'

export type { PersonaValidationError }

export const validatePersona: (p: Partial<Persona>) => PersonaValidationError[] = validate
