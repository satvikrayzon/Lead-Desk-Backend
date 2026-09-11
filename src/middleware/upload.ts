import path from 'path';
import { Request } from 'express';
import multer from 'multer';
import { ALLOWED_AUDIO_MIME_TYPES, MAX_UPLOAD_BYTES } from '../config/env';

const ALLOWED_AUDIO_EXTENSIONS = new Set(['.m4a', '.mp4', '.aac', '.mp3', '.mpeg', '.3gp', '.amr']);

const storage = multer.memoryStorage();

function audioFileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) {
  if (ALLOWED_AUDIO_MIME_TYPES.includes(file.mimetype as (typeof ALLOWED_AUDIO_MIME_TYPES)[number])) {
    cb(null, true);
    return;
  }

  const ext = path.extname(file.originalname || '').toLowerCase();
  if (
    (file.mimetype === 'application/octet-stream' || file.mimetype === 'binary/octet-stream') &&
    ALLOWED_AUDIO_EXTENSIONS.has(ext)
  ) {
    cb(null, true);
    return;
  }

  cb(
    new Error(
      `Invalid file type "${file.mimetype}" (${file.originalname || 'unnamed'}). Allowed: ${ALLOWED_AUDIO_MIME_TYPES.join(', ')} or audio files with extension .m4a/.mp4/.aac/.mp3`
    )
  );
}

export const uploadRecording = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: audioFileFilter,
});

function excelFileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) {
  const ok = /\.(xlsx|xls)$/i.test(file.originalname);
  if (!ok) {
    cb(new Error('Only .xlsx/.xls files are accepted.'));
    return;
  }
  cb(null, true);
}

export const uploadExcel = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: excelFileFilter,
});
