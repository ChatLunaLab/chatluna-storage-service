export interface TempFileInfo {
    path: string
    name: string
    type?: string
    expireTime: Date
    id: string
    size: number
    accessTime: Date
    accessCount: number
    /** Storage backend type (local, s3, webdav, r2). Defaults to 'local' for existing records */
    storageType?: string
    /** Public URL for remote storage backends. If set, backend.ts will redirect to this URL */
    publicUrl?: string
    /** SHA-256 hash of the file content. Empty string if not yet computed. */
    hash: string
}

export interface TempFileInfoWithData<T> extends TempFileInfo {
    data: Promise<T>
    url: string
}
