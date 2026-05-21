/**
 * iCloudAdapter — writes sci.db + sci.idx to ~/Library/Mobile Documents/
 *
 * iCloud Drive on macOS is a filesystem path. Files written here are
 * automatically synced to iCloud by the OS — no API key required.
 * Syncthing can also mirror this path to other devices.
 *
 * Default path: ~/Library/Mobile Documents/iCloud~sci~identity/Documents/
 * (This creates a "Sci Identity" app in iCloud Drive on iOS/macOS.)
 *
 * Override with: SCI_ICLOUD_PATH=~/Library/Mobile Documents/your-path/
 */
import { existsSync, mkdirSync, copyFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { CloudAdapter } from './cloud-adapter.js';
const DEFAULT_ICLOUD_PATH = join(homedir(), 'Library', 'Mobile Documents', 'iCloud~sci~identity', 'Documents');
export class iCloudAdapter extends CloudAdapter {
    backend = 'icloud';
    icloudDir;
    constructor(localDir, icloudPath) {
        super(localDir);
        this.icloudDir = icloudPath ?? DEFAULT_ICLOUD_PATH;
    }
    async _downloadIfNeeded() {
        const remoteDb = join(this.icloudDir, 'sci.db');
        const remoteIdx = join(this.icloudDir, 'sci.idx');
        if (!existsSync(remoteDb))
            return; // Nothing in iCloud yet
        const localExists = existsSync(this.dbPath);
        if (!localExists) {
            console.log('  [icloud] copying from iCloud Drive...');
            if (!existsSync(this.localDir))
                mkdirSync(this.localDir, { recursive: true });
            copyFileSync(remoteDb, this.dbPath);
            if (existsSync(remoteIdx))
                copyFileSync(remoteIdx, this.idxPath);
        }
        // For iCloud, we trust the OS-managed sync — don't compare timestamps
        // iCloud handles conflict resolution natively
    }
    async _sync() {
        try {
            if (!existsSync(this.icloudDir))
                mkdirSync(this.icloudDir, { recursive: true });
            if (existsSync(this.dbPath)) {
                copyFileSync(this.dbPath, join(this.icloudDir, 'sci.db'));
            }
            if (existsSync(this.idxPath)) {
                copyFileSync(this.idxPath, join(this.icloudDir, 'sci.idx'));
            }
            console.log(`  [icloud] synced to ${this.icloudDir}`);
            return { uploaded: 2, downloaded: 0 };
        }
        catch (err) {
            console.error('  [icloud] sync failed:', err instanceof Error ? err.message : err);
            return { uploaded: 0, downloaded: 0 };
        }
    }
}
//# sourceMappingURL=icloud-adapter.js.map