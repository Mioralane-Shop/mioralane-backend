import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import multer from 'multer';
import { ImageKitController } from './imagekit.controller';
import { ImageKitService } from './imagekit.service';

const MAX_TEST_UPLOAD_SIZE_BYTES = 5 * 1024 * 1024;

const imageKitService = new ImageKitService();
const imageKitController = new ImageKitController(imageKitService);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_TEST_UPLOAD_SIZE_BYTES,
  },
  fileFilter: (
    _req: Request,
    _file: unknown,
    callback: (error: Error | null, acceptFile?: boolean) => void
  ) => {
    callback(null, true);
  },
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
          message: 'File exceeds the temporary 5MB limit',
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
  '/test-upload',
  developmentOnly,
  handleSingleUpload,
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
