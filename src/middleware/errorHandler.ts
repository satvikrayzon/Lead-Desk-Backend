import { Request, Response, NextFunction } from 'express';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ message: err.message });
  }

  if (err.message?.includes('Invalid file type')) {
    return res.status(400).json({ message: err.message });
  }

  if (err.message?.includes('Unexpected field')) {
    return res.status(400).json({
      message: 'Invalid multipart form. Expected file field name "recording".',
    });
  }

  // Multer errors
  if (err.name === 'MulterError') {
    const multerErr = err as { code?: string };
    if (multerErr.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ message: 'File too large.' });
    }
    return res.status(400).json({ message: err.message || 'Invalid file upload.' });
  }

  console.error('Unhandled error:', err);
  return res.status(500).json({ message: 'Internal server error.' });
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ message: 'Route not found.' });
}
