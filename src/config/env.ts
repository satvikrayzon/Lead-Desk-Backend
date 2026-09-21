import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  MONGODB_URI: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  /** Access token lifetime (API + Socket.IO). Keep short; clients refresh automatically. */
  JWT_EXPIRES_IN: z.string().default('12h'),
  /** Refresh token lifetime — used only by POST /auth/refresh. */
  JWT_REFRESH_EXPIRES_IN: z.string().default('60d'),
  S3_ENABLED: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === 'true' || v === '1')
    .default(false),
  AWS_ACCESS_KEY_ID: z.string().optional().default(''),
  AWS_SECRET_ACCESS_KEY: z.string().optional().default(''),
  AWS_REGION: z.string().default('ap-south-1'),
  S3_BUCKET_NAME: z.string().optional().default(''),
  S3_ENDPOINT: z.string().optional(),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().default(50),
  CORS_ORIGIN: z.string().optional(),
  PRESIGNED_URL_EXPIRY_MINUTES: z.coerce.number().default(15),
  AUDIT_LOG_RETENTION_DAYS: z.coerce.number().default(365),
  RECORDING_RETENTION_DAYS: z.coerce.number().default(365),
  API_BASE_URL: z.string().url().default('http://172.17.51.195:3000'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const ALLOWED_AUDIO_MIME_TYPES = [
  'audio/mp4',
  'audio/m4a',
  'audio/aac',
  'audio/mpeg',
  'audio/x-m4a',
  'audio/mp3',
  'audio/3gpp',
  'audio/amr',
  'application/octet-stream',
] as const;

export const LEAD_STATUS_VALUES = [
  'new',
  'interested',
  'not_reachable',
  'follow_up',
  'not_interested',
  'converted',
] as const;

export const MAX_UPLOAD_BYTES = env.MAX_UPLOAD_SIZE_MB * 1024 * 1024;
