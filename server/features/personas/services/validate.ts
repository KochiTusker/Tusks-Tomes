import { validatePersona as validate, type PersonaValidationError } from '../../../../shared/personas/validate.js'
import type { Persona } from '../../../../shared/personas/types.js'

export type ValidationError = PersonaValidationError

export const validatePersona: (p: Partial<Persona>) => ValidationError[] = validate
