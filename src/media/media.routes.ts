import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import multer from 'multer';
import { adminGuard } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import { ImageKitService } from '../imagekit/imagekit.service';
import { MediaController } from './media.controller';
import { mediaUploadSchema } from './media.schemas';

const MAX_MEDIA_UPLOAD_SIZE_BYTES = 8 * 1024 * 1024;

const imageKitService = new ImageKitService();
const mediaController = new MediaController(imageKitService);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_MEDIA_UPLOAD_SIZE_BYTES,
  },
  fileFilter: (
    _req: Request,
    _file: unknown,
    callback: (error: Error | null, acceptFile?: boolean) => void
  ) => {
    callback(null, true);
  },
});

const handleSingleUpload: RequestHandler = (req, res, next) => {
  const onUploadComplete: NextFunction = (error) => {
    if (!error) {
      next();
      return;
    }

    const uploadError = error as Error & { code?: string };

    if (uploadError instanceof multer.MulterError) {
      if (uploadError.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          success: false,
          message: 'File exceeds the 8MB upload limit',
        });
        return;
      }

      res.status(400).json({
        success: false,
        message: uploadError.message,
      });
      return;
    }

    const message = uploadError.message || 'Invalid upload request';
    res.status(400).json({
      success: false,
      message,
    });
  };

  upload.single('file')(req, res, onUploadComplete);
};

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
  // missing assetType. The message keeps the route's exact legacy 400 wording.
  validate({ body: mediaUploadSchema, message: 'assetType must be product, combo, or campaign' }),
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
// it is intentionally not imported while the route is disabled.
// // Review images are uploaded by authenticated customers. The asset type is
// // forced to "review" server-side; admin image routes stay admin-only.
// router.post(
//   '/review-images',
//   protect as RequestHandler,
//   handleSingleUpload,
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
