import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { adminGuard } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { createSingleFileUpload } from '../middleware/multipart-upload';
import { requireImageUpload } from '../middleware/upload-validator.middleware';
import { ImageKitService } from '../imagekit/imagekit.service';
import { MediaController } from './media.controller';
import { mediaUploadSchema } from './media-upload.schemas';
import { MAX_MEDIA_UPLOAD_SIZE_BYTES } from './image-upload-policy';

const imageKitService = new ImageKitService();
const mediaController = new MediaController(imageKitService);

/**
 * Multer, built by the shared factory so this route and the dev-only test route
 * cannot drift apart (P1.2, G6). Only the two things that genuinely differ here
 * are passed: the 8MB ceiling and this route's 413 wording.
 */
const handleSingleUpload: RequestHandler = createSingleFileUpload({
  maxBytes: MAX_MEDIA_UPLOAD_SIZE_BYTES,
  tooLargeMessage: 'File exceeds the 8MB upload limit',
});

const router = Router();

// Scoped to the admin image endpoints only. A router-level `use` without a path
// would also guard the customer-facing `/review-images` route below (currently
// disabled) once it is restored.
router.use('/images', ...adminGuard);

router.post(
  '/images',
  handleSingleUpload,
  // MUST stay after handleSingleUpload: multer is what populates req.body for a
  // multipart request, so validating before it would reject every upload with a
  // missing assetType. The message names every asset type the schema accepts:
  // `brand-logo` was added to `MEDIA_ASSET_TYPES` after this sentence was first
  // written, and a rejection that omitted it told the caller a value it had just
  // been allowed to send was invalid.
  validate({ body: mediaUploadSchema, message: 'assetType must be product, combo, campaign, or brand-logo' }),
  // Content check (P1.2). Deliberately after `validate`: a request that is wrong
  // in both ways must keep answering about assetType, which is what this route
  // has always done. Still before the controller, so nothing reaches ImageKit
  // without having had its bytes checked.
  requireImageUpload(),
  (req: Request, res: Response, next: NextFunction) => {
    void mediaController.uploadImage(req, res).catch(next);
  }
);

router.delete(
  '/images/:fileId',
  (req: Request, res: Response, next: NextFunction) => {
    void mediaController.deleteImage(req, res).catch(next);
  }
);

// Review images are temporarily disabled — restore this route to re-enable review image uploads.
// NOTE: re-import `protect` from '../middleware/auth.middleware' when restoring this route;
// it is intentionally not imported while the route is disabled. `handleSingleUpload` and
// `requireImageUpload()` are already imported above, and the commented chain below is
// already complete — uncommenting it is enough.
// // Review images are uploaded by authenticated customers. The asset type is
// // forced to "review" server-side; admin image routes stay admin-only.
// router.post(
//   '/review-images',
//   protect as RequestHandler,
//   handleSingleUpload,
//   requireImageUpload(),
//   (req: Request, res: Response, next: NextFunction) => {
//     void mediaController.uploadReviewImage(req, res).catch(next);
//   }
// );

router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Media route error:', error);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
  });
});

export default router;
