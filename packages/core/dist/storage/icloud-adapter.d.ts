import { CloudAdapter } from './cloud-adapter.js';
export declare class iCloudAdapter extends CloudAdapter {
    readonly backend = "icloud";
    private icloudDir;
    constructor(localDir: string, icloudPath?: string);
    protected _downloadIfNeeded(): Promise<void>;
    protected _sync(): Promise<{
        uploaded: number;
        downloaded: number;
    }>;
}
//# sourceMappingURL=icloud-adapter.d.ts.map