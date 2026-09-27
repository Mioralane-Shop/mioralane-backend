import { z } from 'zod';

/**
 * Converts the empty string and `null` to `undefined` before coercion.
 *
 * Cleared HTML number inputs submit `''`, and `Number('')` is `0` — which for a
 * price would mean "free" rather than "absent". Bare `z.coerce.number()` is
 * therefore banned across these schemas; always go through {@link numericField}.
 */
export const emptyStringToUndefined = (value: unknown): unknown =>
  value === '' || value === null ? undefined : value;

/**
 * A number that also accepts a numeric string (`'2'`), matching what the
 * controllers accepted before validation existed (`Number(value)`). `''`,
 * `null`, `NaN` and non-numeric strings are rejected.
 *
 * Pass constraints to add per-field rules, for example
 * `numericField(z.coerce.number().int().positive().max(999))`.
 */
export const numericField = (
  constraints: z.ZodType<number> = z.coerce.number()
): z.ZodType<number> => z.preprocess(emptyStringToUndefined, constraints);
