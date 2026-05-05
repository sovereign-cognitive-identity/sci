/**
 * S3Adapter — syncs sci.db + sci.idx to s3://bucket/CognitiveOS/
 *
 * Works with any S3-compatible storage: AWS S3, Cloudflare R2, MinIO, Backblaze B2.
 * The user provides credentials via env vars — Sci never stores them.
 *
 * Required env vars:
 *   SCI_S3_BUCKET       — bucket name
 *   SCI_S3_REGION       — AWS region (or 'auto' for R2/Cloudflare)
 *   SCI_S3_ENDPOINT     — optional custom endpoint (for R2, MinIO, etc.)
 *   AWS_ACCESS_KEY_ID   — access key
 *   AWS_SECRET_ACCESS_KEY — secret key
 */
import { existsSync, statSync } from 'fs'
import { CloudAdapter } from './cloud-adapter.js'

const S3_PREFIX = 'CognitiveOS/'
const DB_KEY = `${S3_PREFIX}sci.db`
const IDX_KEY = `${S3_PREFIX}sci.idx`

export class S3Adapter extends CloudAdapter {
  readonly backend: string

  private bucket: string
  private region: string
  private endpoint?: string
  private s3!: import('@aws-sdk/client-s3').S3Client

  constructor(localDir: string, config: {
    bucket: string
    region: string
    endpoint?: string
  }) {
    super(localDir)
    this.bucket = config.bucket
    this.region = config.region
    this.endpoint = config.endpoint
    this.backend = `s3://${config.bucket}`
  }

  private async getS3(): Promise<import('@aws-sdk/client-s3').S3Client> {
    if (this.s3) return this.s3
    const { S3Client } = await import('@aws-sdk/client-s3')
    this.s3 = new S3Client({
      region: this.region,
      ...(this.endpoint ? { endpoint: this.endpoint } : {}),
    })
    return this.s3
  }

  private async getRemoteModified(key: string): Promise<Date | null> {
    try {
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3')
      const s3 = await this.getS3()
      const res = await s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return res.LastModified ?? null
    } catch { return null }
  }

  private async uploadFile(localPath: string, key: string): Promise<void> {
    if (!existsSync(localPath)) return
    const { PutObjectCommand } = await import('@aws-sdk/client-s3')
    const { readFileSync } = await import('fs')
    const s3 = await this.getS3()
    await s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: readFileSync(localPath),
    }))
  }

  private async downloadFile(key: string, localPath: string): Promise<boolean> {
    try {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3')
      const { writeFileSync } = await import('fs')
      const s3 = await this.getS3()
      const res = await s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      if (!res.Body) return false
      // @ts-ignore — Body is a readable stream in Node.js
      const chunks: Buffer[] = []
      for await (const chunk of res.Body as AsyncIterable<Buffer>) chunks.push(chunk)
      writeFileSync(localPath, Buffer.concat(chunks))
      return true
    } catch { return false }
  }

  protected async _downloadIfNeeded(): Promise<void> {
    const remoteModified = await this.getRemoteModified(DB_KEY)
    if (!remoteModified) return

    const localExists = existsSync(this.dbPath)
    if (!localExists) {
      console.log(`  [s3] downloading from ${this.backend}...`)
      await this.downloadFile(DB_KEY, this.dbPath)
      await this.downloadFile(IDX_KEY, this.idxPath)
      return
    }

    const localModified = statSync(this.dbPath).mtime
    if (remoteModified > localModified) {
      console.log(`  [s3] remote is newer, downloading from ${this.backend}...`)
      await this.downloadFile(DB_KEY, this.dbPath)
      await this.downloadFile(IDX_KEY, this.idxPath)
    }
  }

  protected async _sync(): Promise<{ uploaded: number; downloaded: number }> {
    let uploaded = 0
    try {
      await this.uploadFile(this.dbPath, DB_KEY)
      await this.uploadFile(this.idxPath, IDX_KEY)
      uploaded = 2
      console.log(`  [s3] synced to ${this.backend}/${S3_PREFIX}`)
    } catch (err) {
      console.error(`  [s3] sync failed:`, err instanceof Error ? err.message : err)
    }
    return { uploaded, downloaded: 0 }
  }
}
