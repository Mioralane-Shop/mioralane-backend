import { z } from 'zod';
import { numericField } from '../utils/validation';
import { HEX_COLOR_PATTERN } from './announcement-settings.model';

/**
 * Body of `PUT /api/admin/announcement` (the announcement-bar singleton).
 *
 * EVERY FIELD IS OPTIONAL. `normalizeAnnouncementBarPayload` applies
 * `?? DEFAULT_ANNOUNCEMENT_BAR_SETTINGS.x` to each field, so a partial payload is a
 * supported, deliberate "reset the rest to defaults" upsert. Making anything
 * required here would break that contract.
 *
 * WHAT ZOD OWNS: per-field shape, the three enums, the hex-colour pattern and the
 * two numeric ranges — all mirrored from the model, which is the source of truth
 * (the enum tuples and `HEX_COLOR_PATTERN` are imported rather than re-typed).
 *
 * WHAT STAYS IN THE SERVICE, and why Zod cannot take it:
 *  - **blank-message dropping.** Rows whose `text` is empty after trimming are
 *    filtered out. `text` is therefore *not* `min(1)` here — a blank row is valid
 *    input that gets dropped, not a validation failure.
 *  - **"at least one message before enabling".** It is evaluated *after* the drop,
 *    so its inputs do not exist at the edge: Zod would see `messages: ['']` and
 *    happily pass a payload the storefront must reject.
 *  - **uppercasing the colours** (`normalizeColor`), which is live work.
 *
 * All four checks in that list feed values that go straight into inline storefront
 * CSS, which is why the normalizer is kept intact rather than hollowed out — see
 * the P0-3.12 report.
 */
export const ANNOUNCEMENT_ANIMATIONS = ['slide', 'fade', 'marquee'] as const;
export const ANNOUNCEMENT_DIRECTIONS = ['ltr', 'rtl'] as const;
export const ANNOUNCEMENT_BACKGROUNDS = ['solid', 'sheen', 'gradient'] as const;
export const MAX_ANNOUNCEMENT_MESSAGE_LENGTH = 220;

const hexColourField = z
    .string()
    .trim()
    .regex(HEX_COLOR_PATTERN, 'Colour must be a six digit hex value, for example #006400');

export const announcementSettingsSchema = z.object({
    enabled: z.boolean().optional(),
    messages: z
        .array(
            z.object({
                /** Deliberately not `min(1)` — blank rows are dropped by the service. */
                text: z
                    .string()
                    .trim()
                    .max(
                        MAX_ANNOUNCEMENT_MESSAGE_LENGTH,
                        `Message must be ${MAX_ANNOUNCEMENT_MESSAGE_LENGTH} characters or fewer`
                    )
                    .optional(),
                url: z.string().trim().optional(),
            })
        )
        .optional(),
    animation: z.enum(ANNOUNCEMENT_ANIMATIONS).optional(),
    direction: z.enum(ANNOUNCEMENT_DIRECTIONS).optional(),
    background: z.enum(ANNOUNCEMENT_BACKGROUNDS).optional(),
    backgroundColor: hexColourField.optional(),
    textColor: hexColourField.optional(),
    intervalSeconds: numericField(z.coerce.number().min(2).max(60)).optional(),
    speedSeconds: numericField(z.coerce.number().min(6).max(60)).optional(),
});

export type AnnouncementSettingsInput = z.infer<typeof announcementSettingsSchema>;
