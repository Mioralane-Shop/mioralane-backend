declare module 'multer' {
  import { Request, RequestHandler } from 'express';

  export interface File {
    mimetype: string;
    originalname: string;
    buffer: Buffer;
    size: number;
  }

  export interface MulterError extends Error {
    code: string;
    field?: string;
  }

  export type FileFilterCallback = (error: Error | null, acceptFile?: boolean) => void;

  export interface Options {
    storage?: unknown;
    limits?: {
      fileSize?: number;
    };
    fileFilter?: (req: Request, file: File, callback: FileFilterCallback) => void;
  }

  export interface Multer {
    single(fieldName: string): RequestHandler;
  }

  function multer(options?: Options): Multer;

  namespace multer {
    function memoryStorage(): unknown;
    const MulterError: {
      new (message: string, code: string): MulterError;
    };
  }

  export = multer;
}
