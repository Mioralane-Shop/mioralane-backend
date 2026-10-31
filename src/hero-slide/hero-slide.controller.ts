import mongoose from 'mongoose';
import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { sanitizeValidationMessages } from '../middleware/error.middleware';
import {
  buildActivityChanges,
  recordActivity,
  resolveUpdateAction,
} from '../activity-log/activity-log.service';
import {
  createHeroSlide,
  deleteHeroSlide,
  getHeroSlideById,
  listActiveHeroSlides,
  listAllHeroSlides,
  reorderHeroSlides,
  updateHeroSlide,
} from './hero-slide.service';
import type {
  CreateHeroSlideInput,
  ReorderHeroSlidesInput,
  UpdateHeroSlideInput,
} from './hero-slide.schemas';

const getParamId = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value[0] : value ?? '';

const isObjectId = (value: string): boolean => mongoose.Types.ObjectId.isValid(value);

/** Status mapping for a write, in one place. */
const sendHeroSlideError = (res: Response, error: unknown, label: string): void => {
  const err = error as { statusCode?: number; message?: string; code?: string };

  if (err.statusCode === 400 || err.statusCode === 404) {
    res.status(err.statusCode).json({
      success: false,
      message: err.message,
      code: err.code,
    });
    return;
  }

  if (error instanceof mongoose.Error.ValidationError) {
    res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: sanitizeValidationMessages(error),
    });
    return;
  }

  console.error(label, error);
  res.status(500).json({ success: false, message: 'Internal server error' });
};

/* ─────────────────────────── public reads ─────────────────────────── */

/** Storefront: the active slides, in display order. */
export const listPublicHeroSlides = async (
  _req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  res.json({ success: true, slides: await listActiveHeroSlides() });
};

/* ──────────────────────────── admin reads ─────────────────────────── */

export const listAdminHeroSlides = async (
  _req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  res.json({ success: true, slides: await listAllHeroSlides() });
};

/* ──────────────────────────── admin writes ────────────────────────── */

export const createAdminHeroSlide = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    // `req.body` is the parsed `createHeroSlideSchema` output, so unknown keys are
    // already gone and `createdAt`/`_id`/`__v` cannot reach the model.
    const slide = await createHeroSlide(req.body as CreateHeroSlideInput);

    await recordActivity(req, {
      action: 'CREATE',
      entityType: 'HERO_SLIDE',
      entityId: slide.id,
      entityName: slide.altText || slide.imageUrl,
      after: { imageUrl: slide.imageUrl, targetUrl: slide.targetUrl, order: slide.order, isActive: slide.isActive },
    });

    res.status(201).json({ success: true, slide });
  } catch (error) {
    sendHeroSlideError(res, error, '[createAdminHeroSlide]');
  }
};

export const updateAdminHeroSlide = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    // The route validated `:id` through `objectIdParam`; the check stays so the 400
    // is a property of the handler that needs the id.
    const id = getParamId(req.params.id);
    if (!isObjectId(id)) {
      res.status(400).json({ success: false, message: 'Invalid hero slide ID' });
      return;
    }

    const before = await getHeroSlideById(id);
    if (!before) {
      res.status(404).json({ success: false, message: 'Hero slide not found' });
      return;
    }

    const slide = await updateHeroSlide(id, req.body as UpdateHeroSlideInput);

    if (!slide) {
      res.status(404).json({ success: false, message: 'Hero slide not found' });
      return;
    }

    const changes = buildActivityChanges(
      before as unknown as Record<string, unknown>,
      slide as unknown as Record<string, unknown>
    );

    if (changes.changedFields.length > 0) {
      await recordActivity(req, {
        action: resolveUpdateAction(changes.changedFields),
        entityType: 'HERO_SLIDE',
        entityId: slide.id,
        entityName: slide.altText || slide.imageUrl,
        before: changes.before,
        after: changes.after,
        metadata: { changedFields: changes.changedFields },
      });
    }

    res.json({ success: true, slide });
  } catch (error) {
    sendHeroSlideError(res, error, '[updateAdminHeroSlide]');
  }
};

export const deleteAdminHeroSlide = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const id = getParamId(req.params.id);
    if (!isObjectId(id)) {
      res.status(400).json({ success: false, message: 'Invalid hero slide ID' });
      return;
    }

    const before = await getHeroSlideById(id);
    const removed = await deleteHeroSlide(id);

    if (!removed) {
      res.status(404).json({ success: false, message: 'Hero slide not found' });
      return;
    }

    await recordActivity(req, {
      action: 'DELETE',
      entityType: 'HERO_SLIDE',
      entityId: id,
      entityName: before?.altText || before?.imageUrl,
      before: before
        ? { imageUrl: before.imageUrl, targetUrl: before.targetUrl, order: before.order, isActive: before.isActive }
        : undefined,
    });

    res.json({ success: true });
  } catch (error) {
    sendHeroSlideError(res, error, '[deleteAdminHeroSlide]');
  }
};

/**
 * Bulk reorder. `matched` is reported back so the admin page can tell a full apply
 * from one where an id in the payload no longer exists.
 */
export const reorderAdminHeroSlides = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const entries = req.body as ReorderHeroSlidesInput;
    const result = await reorderHeroSlides(entries);

    res.json({ success: true, updated: result.matched });
  } catch (error) {
    sendHeroSlideError(res, error, '[reorderAdminHeroSlides]');
  }
};
