import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { env } from './env';
import { logger } from './logger';

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!env.S3_ENABLED) {
    throw new Error('S3 is not enabled');
  }

  if (!s3Client) {
    s3Client = new S3Client({
      region: env.AWS_REGION,
      endpoint: env.S3_ENDPOINT || undefined,
      forcePathStyle: !!env.S3_ENDPOINT,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });
  }

  return s3Client;
}

export async function checkS3Connection(): Promise<boolean> {
  if (!env.S3_ENABLED) {
    return true;
  }

  try {
    await getS3Client().send(new HeadBucketCommand({ Bucket: env.S3_BUCKET_NAME }));
    logger.info({ bucket: env.S3_BUCKET_NAME }, 'S3 connection check succeeded');
    return true;
  } catch (err) {
    logger.error(
      { err, bucket: env.S3_BUCKET_NAME },
      'S3 connection check failed'
    );
    return false;
  }
}

export async function uploadToS3(params: {
  key: string;
  body: Buffer;
  contentType: string;
  contentLength?: number;
}): Promise<void> {
  const bucket = env.S3_BUCKET_NAME;
  const sizeBytes = params.contentLength ?? params.body.length;

  logger.info(
    {
      bucket,
      key: params.key,
      contentType: params.contentType,
      sizeBytes,
    },
    'S3 upload started'
  );

  try {
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: params.key,
        Body: params.body,
        ContentType: params.contentType,
        ContentLength: params.contentLength,
        ServerSideEncryption: 'AES256',
      })
    );

    logger.info(
      {
        bucket,
        key: params.key,
        contentType: params.contentType,
        sizeBytes,
      },
      'S3 upload succeeded'
    );
  } catch (err) {
    logger.error(
      {
        err,
        bucket,
        key: params.key,
        contentType: params.contentType,
        sizeBytes,
      },
      'S3 upload failed'
    );
    throw err;
  }
}

export async function deleteFromS3(key: string): Promise<void> {
  const bucket = env.S3_BUCKET_NAME;

  try {
    await getS3Client().send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );
    logger.info({ bucket, key }, 'S3 delete succeeded');
  } catch (err) {
    logger.error({ err, bucket, key }, 'S3 delete failed');
    throw err;
  }
}

export async function getPresignedUrl(key: string): Promise<{ url: string; expiresAt: string }> {
  const bucket = env.S3_BUCKET_NAME;
  const expiresIn = env.PRESIGNED_URL_EXPIRY_MINUTES * 60;

  logger.info(
    { bucket, key, expiresInSeconds: expiresIn },
    'S3 presigned URL generation started'
  );

  try {
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    });

    const url = await getSignedUrl(getS3Client(), command, { expiresIn });
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    logger.info(
      {
        bucket,
        key,
        expiresAt,
        urlHost: (() => {
          try {
            return new URL(url).host;
          } catch {
            return null;
          }
        })(),
      },
      'S3 presigned URL generated successfully'
    );

    return { url, expiresAt };
  } catch (err) {
    logger.error(
      { err, bucket, key, expiresInSeconds: expiresIn },
      'S3 presigned URL generation failed'
    );
    throw err;
  }
}
