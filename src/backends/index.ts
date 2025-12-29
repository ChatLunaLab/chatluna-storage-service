export * from './base'
export { LocalStorageBackend } from './local'
export { S3StorageBackend } from './s3'
export { WebDAVStorageBackend } from './webdav'
export { R2StorageBackend } from './r2'

import { StorageBackend, StorageConfig } from './base'
import { LocalStorageBackend } from './local'
import { S3StorageBackend } from './s3'
import { WebDAVStorageBackend } from './webdav'
import { R2StorageBackend } from './r2'

export function createStorageBackend(config: StorageConfig): StorageBackend {
    switch (config.type) {
        case 'local':
            return new LocalStorageBackend(config)
        case 's3':
            return new S3StorageBackend(config)
        case 'webdav':
            return new WebDAVStorageBackend(config)
        case 'r2':
            return new R2StorageBackend(config)
        default:
            throw new Error(`Unknown storage backend type: ${(config as StorageConfig).type}`)
    }
}
