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
  brandSnapshot,
  createBrand,
  deleteBrand,
  getBrandById,
  listAllBrands,
  listMarqueeBrands,
  listVisibleBrands,
  reorderBrands,
  updateBrand,
} from './brand.service';
import type { CreateBrandInput, ReorderBrandsInput, UpdateBrandInput } from './brand.schemas';

const getParamId = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? value[0] : value ?? '';

const isObjectId = (value: string): boolean => mongoose.Types.ObjectId.isValid(value);

/**
 * Status mapping for a write, in one place.
 *
 * `code === 11000` is the unique index on `slug` firing — the only way two brands
 * can collide, and the reason uniqueness is not a schema `refine`: a pre-check
 * would race, and a refine would put a database query inside validation.
 */
const sendBrandError = (res: Response, error: unknown, label: string): void => {
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

  if ((error as { code?: number }).code === 11000) {
    res.status(409).json({ success: false, message: 'Brand slug must be unique' });
    return;
  }

  console.error(label, error);
  res.status(500).json({ success: false, message: 'Internal server error' });
};

/* ─────────────────────────── public reads ─────────────────────────── */

/** Storefront: the brands the customer-facing nav may show, in display order. */
export const listPublicBrands = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.json({ success: true, brands: await listVisibleBrands() });
};

/**
 * Storefront: the homepage marquee. A separate route rather than a query flag on
 * the list above, because the filter is not a client choice — a brand without a
 * logo cannot be rendered by the marquee whatever the caller asks for.
 */
export const listMarqueeBrandsHandler = async (
  _req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  res.json({ success: true, brands: await listMarqueeBrands() });
};

/* ──────────────────────────── admin reads ─────────────────────────── */

export const listAdminBrands = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.json({ success: true, brands: await listAllBrands() });
};

export const getAdminBrand = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  // The route already validated `:id` through `objectIdParam`, so this branch is
  // unreachable from it. It stays because it makes the 400 a property of the
  // handler that needs the id: a route added without the middleware still
  // refuses, and dropping one layer cannot open a hole.
  const id = getParamId(req.params.id);
  if (!isObjectId(id)) {
    res.status(400).json({ success: false, message: 'Invalid brand ID' });
    return;
  }

  const brand = await getBrandById(id);

  if (!brand) {
    res.status(404).json({ success: false, message: 'Brand not found' });
    return;
  }

  res.json({ success: true, brand });
};

/* ──────────────────────────── admin writes ────────────────────────── */

export const createAdminBrand = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    // `req.body` is the parsed `createBrandSchema` output: unknown keys are gone,
    // so `createdAt`/`_id`/`__v` in a request cannot reach the model.
    const brand = await createBrand(req.body as CreateBrandInput);

    await recordActivity(req, {
      action: 'CREATE',
      entityType: 'BRAND',
      entityId: brand.id,
      entityName: brand.name,
      after: brandSnapshot(brand),
    });

    res.status(201).json({ success: true, brand });
  } catch (error) {
    sendBrandError(res, error, '[createAdminBrand]');
  }
};

export const updateAdminBrand = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    // Same second layer as `getAdminBrand`: see the note there.
    const id = getParamId(req.params.id);
    if (!isObjectId(id)) {
      res.status(400).json({ success: false, message: 'Invalid brand ID' });
      return;
    }

    const result = await updateBrand(id, req.body as UpdateBrandInput);

    if (!result) {
      res.status(404).json({ success: false, message: 'Brand not found' });
      return;
    }

    const changes = buildActivityChanges(
      brandSnapshot(result.before),
      brandSnapshot(result.after)
    );

    // Only when something actually changed: a save that altered nothing is not an
    // event, and logging it would bury the entries that are.
    if (changes.changedFields.length > 0) {
      await recordActivity(req, {
        action: resolveUpdateAction(changes.changedFields),
        entityType: 'BRAND',
        entityId: result.after.id,
        entityName: result.after.name,
        before: changes.before,
        after: changes.after,
        metadata: { changedFields: changes.changedFields },
      });
    }

    res.json({ success: true, brand: result.after });
  } catch (error) {
    sendBrandError(res, error, '[updateAdminBrand]');
  }
};

export const deleteAdminBrand = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    // Same second layer as `getAdminBrand`: see the note there.
    const id = getParamId(req.params.id);
    if (!isObjectId(id)) {
      res.status(400).json({ success: false, message: 'Invalid brand ID' });
      return;
    }

    const brand = await deleteBrand(id);

    if (!brand) {
      res.status(404).json({ success: false, message: 'Brand not found' });
      return;
    }

    await recordActivity(req, {
      action: 'DELETE',
      entityType: 'BRAND',
      entityId: brand.id,
      entityName: brand.name,
      before: brandSnapshot(brand),
    });

    res.json({ success: true, message: 'Brand deleted successfully' });
  } catch (error) {
    sendBrandError(res, error, '[deleteAdminBrand]');
  }
};

/**
 * Reorder. A partial application is a 404 rather than a 200: every id in the body
 * came from a list the admin just saw, so one that no longer exists means the list
 * was stale, and reporting success would leave the UI showing an order the
 * database does not have.
 */
export const reorderAdminBrands = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    const { matched, expected } = await reorderBrands(req.body as ReorderBrandsInput);

    if (matched !== expected) {
      res.status(404).json({
        success: false,
        message: 'One or more brands no longer exist',
      });
      return;
    }

    res.json({ success: true, updated: matched });
  } catch (error) {
    sendBrandError(res, error, '[reorderAdminBrands]');
  }
};
