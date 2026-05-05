/**
 * DropboxAdapter — syncs sci.db + sci.idx to /CognitiveOS/ in the user's Dropbox.
 *
 * Uses the Dropbox API v2. The user provides an access token at setup.
 * Sci never stores the token — it's passed in via env var.
 *
 * Sync strategy: upload on disconnect, download on connect (if remote is newer).
 * Future: conflict resolution, delta sync.
 */
import { createReadStream, createWriteStream, statSync, existsSync } from 'fs'
import { join } from 'path'
import { CloudAdapter } from './cloud-adapter.js'

const DROPBOX_FOLDER = '/CognitiveOS'
const DB_REMOTE = `${DROPBOX_FOLDER}/sci.db`
const IDX_REMOTE = `${DROPBOX_FOLDER}/sci.idx`

export class DropboxAdapter extends CloudAdapter {
  readonly backend = 'dropbox'

  private token: string

  constructor(localDir: string, accessToken: string) {
    super(localDir)
    this.token = accessToken
  }

  private async dbxFetch(endpoint: string, body: unknown, isDownload = false): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    }
    if (!isDownload) {
      headers['Content-Type'] = 'application/json'
    } else {
      headers['Content-Type'] = 'application/octet-stream'
      headers['Dropbox-API-Arg'] = JSON.stringify(body)
    }
    return fetch(
      isDownload
        ? 'https://content.dropboxapi.com/2/files/download'
        : `https://api.dropboxapi.com/2/${endpoint}`,
      {
        method: 'POST',
        headers,
        body: isDownload ? undefined : JSON.stringify(body),
      }
    )
  }

  private async getRemoteModified(path: string): Promise<Date | null> {
    try {
      const res = await this.dbxFetch('files/get_metadata', { path })
      if (!res.ok) return null
      const data = await res.json() as { server_modified?: string }
      return data.server_modified ? new Date(data.server_modified) : null
    } catch { return null }
  }

  private async uploadFile(localPath: string, remotePath: string): Promise<void> {
    if (!existsSync(localPath)) return
    const content = await import('fs').then(fs => fs.promises.readFile(localPath))
    await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify({
          path: remotePath,
          mode: 'overwrite',
          autorename: false,
          mute: true,
        }),
      },
      body: content,
    })
  }

  private async downloadFile(remotePath: string, localPath: string): Promise<boolean> {
    try {
      const res = await fetch('https://content.dropboxapi.com/2/files/download', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Dropbox-API-Arg': JSON.stringify({ path: remotePath }),
        },
      })
      if (!res.ok) return false
      const buf = await res.arrayBuffer()
      await import('fs').then(fs => fs.promises.writeFile(localPath, Buffer.from(buf)))
      return true
    } catch { return false }
  }

  protected async _downloadIfNeeded(): Promise<void> {
    const remoteDbModified = await this.getRemoteModified(DB_REMOTE)
    if (!remoteDbModified) return  // Nothing in Dropbox yet — first run

    const localDbExists = existsSync(this.dbPath)
    if (!localDbExists) {
      // First time on this machine — download from Dropbox
      console.log('  [dropbox] downloading sci.db from Dropbox...')
      await this.downloadFile(DB_REMOTE, this.dbPath)
      await this.downloadFile(IDX_REMOTE, this.idxPath)
      return
    }

    // Compare modification times
    const localDbModified = statSync(this.dbPath).mtime
    if (remoteDbModified > localDbModified) {
      console.log('  [dropbox] remote is newer, downloading...')
      await this.downloadFile(DB_REMOTE, this.dbPath)
      await this.downloadFile(IDX_REMOTE, this.idxPath)
    }
  }

  protected async _sync(): Promise<{ uploaded: number; downloaded: number }> {
    let uploaded = 0
    try {
      await this.uploadFile(this.dbPath, DB_REMOTE)
      await this.uploadFile(this.idxPath, IDX_REMOTE)
      uploaded = 2
      console.log('  [dropbox] synced sci.db + sci.idx to /CognitiveOS/')
    } catch (err) {
      console.error('  [dropbox] sync failed:', err instanceof Error ? err.message : err)
    }
    return { uploaded, downloaded: 0 }
  }
}
