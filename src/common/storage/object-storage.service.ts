import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';

/** The settings an S3-compatible bucket needs — Cloudflare R2, Amazon S3, Backblaze B2, DigitalOcean Spaces, MinIO. */
export interface ObjectStorageConfig {
  /** Left out for Amazon S3 itself; the provider's S3 endpoint otherwise, e.g. https://<account>.r2.cloudflarestorage.com. */
  endpoint?: string;
  /** `auto` for R2; the bucket's region elsewhere. */
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The bucket from the environment, or null until all three of bucket, key id and secret are set. */
export function objectStorageConfig(env: NodeJS.ProcessEnv = process.env): ObjectStorageConfig | null {
  const bucket = env.STORAGE_S3_BUCKET?.trim();
  const accessKeyId = env.STORAGE_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.STORAGE_S3_SECRET_ACCESS_KEY?.trim();
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    endpoint: env.STORAGE_S3_ENDPOINT?.trim() || undefined,
    region: env.STORAGE_S3_REGION?.trim() || 'auto',
    bucket,
    accessKeyId,
    secretAccessKey,
  };
}

const S3_URL = /^s3:\/\/([^/]+)\/(.+)$/;

/**
 * One private S3-compatible bucket for everything this app keeps outside the
 * database: room photos (served through the API, never straight from the
 * bucket), encrypted guest documents and backups, each under its own prefix.
 * Off until the bucket is configured — then `configured` is false and the
 * callers keep to what they did before (documents and backups on the
 * server's own disk, photos as pasted links).
 */
@Injectable()
export class ObjectStorageService {
  private readonly logger = new Logger(ObjectStorageService.name);
  private readonly config = objectStorageConfig();
  private readonly client = this.config
    ? new S3Client({
        region: this.config.region,
        endpoint: this.config.endpoint,
        credentials: { accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey },
        // R2, MinIO and most S3-compatible stores want bucket/key paths, not bucket subdomains.
        forcePathStyle: Boolean(this.config.endpoint),
      })
    : null;

  get configured(): boolean {
    return this.client !== null;
  }

  /** Where `key` lives, as stored on a record: `s3://<bucket>/<key>`. */
  urlFor(key: string): string {
    return `s3://${this.requireConfig().bucket}/${key}`;
  }

  /** The key a stored `s3://` address names — null for anything else (a `file://` path from before the bucket). */
  keyOf(storageUrl: string): string | null {
    const match = S3_URL.exec(storageUrl);
    return match ? match[2] : null;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<string> {
    await this.requireClient().send(new PutObjectCommand({ Bucket: this.requireConfig().bucket, Key: key, Body: body, ContentType: contentType }));
    return this.urlFor(key);
  }

  /** The object's bytes and type, or null when there's no such object. */
  async get(key: string): Promise<{ body: Buffer; contentType: string | undefined } | null> {
    try {
      const result = await this.requireClient().send(new GetObjectCommand({ Bucket: this.requireConfig().bucket, Key: key }));
      if (!result.Body) return null;
      return { body: Buffer.from(await result.Body.transformToByteArray()), contentType: result.ContentType };
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') return null;
      throw error;
    }
  }

  /** Deletes for good. An object already gone is not an error (S3 itself says so). */
  async remove(key: string): Promise<void> {
    await this.requireClient().send(new DeleteObjectCommand({ Bucket: this.requireConfig().bucket, Key: key }));
  }

  /** Best effort, for clean-up that must never fail the work around it. */
  async removeQuietly(key: string): Promise<void> {
    try {
      await this.remove(key);
    } catch (error) {
      this.logger.warn(`Could not delete ${key} from storage: ${(error as Error).message}`);
    }
  }

  private requireClient(): S3Client {
    if (!this.client) throw new Error('Object storage is not configured — set STORAGE_S3_BUCKET, STORAGE_S3_ACCESS_KEY_ID and STORAGE_S3_SECRET_ACCESS_KEY');
    return this.client;
  }

  private requireConfig(): ObjectStorageConfig {
    if (!this.config) throw new Error('Object storage is not configured');
    return this.config;
  }
}
