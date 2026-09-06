import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import multer from 'multer';
import { adminOnly, protect } from '../middleware/auth.middleware';
import { ImageKitService } from '../imagekit/imagekit.service';
import { MediaController } from './media.controller';

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

router.post(
  '/images',
  protect as RequestHandler,
  adminOnly as RequestHandler,
  handleSingleUpload,
  (req: Request, res: Response, next: NextFunction) => {
    void mediaController.uploadImage(req, res).catch(next);
  }
);

router.delete(
  '/images/:fileId',
  protect as RequestHandler,
  adminOnly as RequestHandler,
  (req: Request, res: Response, next: NextFunction) => {
    void mediaController.deleteImage(req, res).catch(next);
  }
);

router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Media route error:', error);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
  });
});

export default router;
