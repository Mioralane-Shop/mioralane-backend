import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { createSingleFileUpload } from '../middleware/multipart-upload';
import { requireImageUpload } from '../middleware/upload-validator.middleware';
import { ImageKitController } from './imagekit.controller';
import { ImageKitService } from './imagekit.service';

const MAX_TEST_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024;

const imageKitService = new ImageKitService();
const imageKitController = new ImageKitController(imageKitService);

/**
 * Shared pipeline (P1.2, G6). This route keeps its own tighter 5MB ceiling and
 * its own 413 wording; everything else — memory storage, the accept-all
 * `fileFilter`, and the `MulterError` mapping — comes from the factory used by
 * `media.routes.ts`, so a fix to one path cannot miss the other.
 */
const handleSingleUpload: RequestHandler = createSingleFileUpload({
  maxBytes: MAX_TEST_UPLOAD_SIZE_BYTES,
  tooLargeMessage: 'File exceeds the temporary 5MB limit',
});

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

const developmentOnly: RequestHandler = (_req, res, next) => {
  if (isProduction()) {
    res.status(404).json({
      success: false,
      message: 'Not found',
    });
    return;
  }

  next();
};

const router = Router();

router.post(
  '/test-upload',
  developmentOnly,
  handleSingleUpload,
  // Same content guard as the media route (P1.2): this route used to run its own
  // detection with its own message, one of which listed GIF as allowed.
  requireImageUpload(),
  (req: Request, res: Response, next: NextFunction) => {
    void imageKitController.testUpload(req, res).catch(next);
  }
);

router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('ImageKit route error:', error);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
  });
});

export default router;
