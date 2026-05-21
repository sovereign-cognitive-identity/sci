import { CloudAdapter } from './cloud-adapter.js';
export declare class S3Adapter extends CloudAdapter {
    readonly backend: string;
    private bucket;
    private region;
    private endpoint?;
    private s3;
    constructor(localDir: string, config: {
        bucket: string;
        region: string;
        endpoint?: string;
    });
    private getS3;
    private getRemoteModified;
    private uploadFile;
    private downloadFile;
    protected _downloadIfNeeded(): Promise<void>;
    protected _sync(): Promise<{
        uploaded: number;
        downloaded: number;
    }>;
}
//# sourceMappingURL=s3-adapter.d.ts.map