import { CloudAdapter } from './cloud-adapter.js';
export declare class DropboxAdapter extends CloudAdapter {
    readonly backend = "dropbox";
    private token;
    constructor(localDir: string, accessToken: string);
    private dbxFetch;
    private getRemoteModified;
    private uploadFile;
    private downloadFile;
    protected _downloadIfNeeded(): Promise<void>;
    protected _sync(): Promise<{
        uploaded: number;
        downloaded: number;
    }>;
}
//# sourceMappingURL=dropbox-adapter.d.ts.map