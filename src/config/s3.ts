import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { env } from './env';

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
    return true;
  } catch {
    return false;
  }
}

export async function uploadToS3(params: {
  key: string;
  body: Buffer;
  contentType: string;
  contentLength?: number;
}): Promise<void> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET_NAME,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
      ContentLength: params.contentLength,
      ServerSideEncryption: 'AES256',
    })
  );
}

export async function deleteFromS3(key: string): Promise<void> {
  await getS3Client().send(
    new DeleteObjectCommand({
      Bucket: env.S3_BUCKET_NAME,
      Key: key,
    })
  );
}

export async function getPresignedUrl(key: string): Promise<{ url: string; expiresAt: string }> {
  const command = new GetObjectCommand({
    Bucket: env.S3_BUCKET_NAME,
    Key: key,
  });

  const expiresIn = env.PRESIGNED_URL_EXPIRY_MINUTES * 60;
  const url = await getSignedUrl(getS3Client(), command, { expiresIn });
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  return { url, expiresAt };
}
