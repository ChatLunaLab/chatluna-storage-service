import { Context, Service, Time } from 'koishi'
import { Config, logger } from '..'
import { TempFileInfo, TempFileInfoWithData } from '../types'
import { getImageType, randomFileName } from '../utils'
import { StorageBackend, createStorageBackend, StorageConfig } from '../backends'
import fs from 'fs/promises'

interface LRUNode {
    fileId: string
    prev: LRUNode | null
    next: LRUNode | null
}
export class ChatLunaStorageService extends Service {
    private lruHead: LRUNode
    private lruTail: LRUNode
    private lruMap: Map<string, LRUNode>

    private backendPath: string
    private storageBackend: StorageBackend

    constructor(
        ctx: Context,
        public config: Config
    ) {
        super(ctx, 'chatluna_storage', true)

        this.lruHead = { fileId: '', prev: null, next: null }
        this.lruTail = { fileId: '', prev: null, next: null }
        this.lruHead.next = this.lruTail
        this.lruTail.prev = this.lruHead
        this.lruMap = new Map()

        this.backendPath = this.config.backendPath

        // Initialize storage backend based on config
        this.storageBackend = createStorageBackend(this.getStorageConfig())

        ctx.database.extend(
            'chatluna_storage_temp',
            {
                id: { type: 'string', length: 254 },
                path: 'string',
                name: 'string',
                type: {
                    type: 'string',
                    nullable: true
                },
                expireTime: 'timestamp',
                size: 'integer',
                accessTime: 'timestamp',
                accessCount: 'integer',
                // New optional fields for multi-backend support
                storageType: {
                    type: 'string',
                    nullable: true
                },
                publicUrl: {
                    type: 'string',
                    nullable: true
                }
            },
            {
                autoInc: false,
                primary: 'id'
            }
        )

        this.setupAutoDelete()
        this.initializeLRU()
        this.initStorageBackend()

        ctx.inject(['server'], (ctx) => {
            const backendPath = `${config.serverPath ?? ctx.server.selfUrl}${this.config.backendPath}`
            this.backendPath = backendPath
        })
    }

    private getStorageConfig(): StorageConfig {
        const backendType = this.config.storageBackend ?? 'local'

        switch (backendType) {
            case 's3':
                return {
                    type: 's3',
                    endpoint: this.config.s3Endpoint!,
                    bucket: this.config.s3Bucket!,
                    region: this.config.s3Region!,
                    accessKeyId: this.config.s3AccessKeyId!,
                    secretAccessKey: this.config.s3SecretAccessKey!,
                    publicUrl: this.config.s3PublicUrl,
                    pathStyle: this.config.s3PathStyle
                }
            case 'webdav':
                return {
                    type: 'webdav',
                    endpoint: this.config.webdavEndpoint!,
                    username: this.config.webdavUsername,
                    password: this.config.webdavPassword,
                    basePath: this.config.webdavBasePath,
                    publicUrl: this.config.webdavPublicUrl
                }
            case 'r2':
                return {
                    type: 'r2',
                    accountId: this.config.r2AccountId!,
                    bucket: this.config.r2Bucket!,
                    accessKeyId: this.config.r2AccessKeyId!,
                    secretAccessKey: this.config.r2SecretAccessKey!,
                    publicUrl: this.config.r2PublicUrl
                }
            case 'local':
            default:
                return {
                    type: 'local',
                    storagePath: this.config.storagePath
                }
        }
    }

    private async initStorageBackend() {
        try {
            await this.storageBackend.init()
            logger.info(`Storage backend initialized: ${this.storageBackend.type}`)
        } catch (error) {
            logger.error('Failed to initialize storage backend:', error)
        }
    }

    private async initializeLRU() {
        const files = await this.ctx.database.get('chatluna_storage_temp', {})
        files.sort((a, b) => b.accessTime.getTime() - a.accessTime.getTime())
        for (const file of files) {
            this.addToLRU(file.id)
        }
    }

    private addToLRU(fileId: string) {
        if (this.lruMap.has(fileId)) {
            this.removeFromLRU(fileId)
        }

        const newNode: LRUNode = {
            fileId,
            prev: this.lruHead,
            next: this.lruHead.next
        }
        this.lruHead.next!.prev = newNode
        this.lruHead.next = newNode
        this.lruMap.set(fileId, newNode)
    }

    private removeFromLRU(fileId: string) {
        const node = this.lruMap.get(fileId)
        if (node) {
            node.prev!.next = node.next
            node.next!.prev = node.prev
            this.lruMap.delete(fileId)
        }
    }

    private getLRUVictim(): string | null {
        if (this.lruTail.prev === this.lruHead) return null
        const victim = this.lruTail.prev!
        return victim.fileId
    }

    private async cleanupByStorageSize() {
        const files = await this.ctx.database.get('chatluna_storage_temp', {})
        const totalSize = files.reduce((sum, file) => sum + file.size, 0)
        const maxSizeBytes = this.config.maxStorageSize * 1024 * 1024

        if (totalSize <= maxSizeBytes) return

        const sortedFiles = files.sort((a, b) => a.accessTime.getTime() - b.accessTime.getTime())
        let currentSize = totalSize

        for (const file of sortedFiles) {
            if (currentSize <= maxSizeBytes * 0.8) break

            try {
                await this.deleteFileFromBackend(file)
                await this.ctx.database.remove('chatluna_storage_temp', {
                    id: file.id
                })
                this.removeFromLRU(file.id)
                currentSize -= file.size
            } catch (error) {
                await this.ctx.database.remove('chatluna_storage_temp', {
                    id: file.id
                })
                this.removeFromLRU(file.id)
                currentSize -= file.size
            }
        }
    }

    private async cleanupByFileCount() {
        const files = await this.ctx.database.get('chatluna_storage_temp', {})

        if (files.length <= this.config.maxStorageCount) return

        const sortedFiles = files.sort((a, b) => a.accessTime.getTime() - b.accessTime.getTime())
        const filesToDelete =
            files.length - Math.floor(this.config.maxStorageCount * 0.8)

        for (let i = 0; i < filesToDelete; i++) {
            const file = sortedFiles[i]
            try {
                await this.deleteFileFromBackend(file)
                await this.ctx.database.remove('chatluna_storage_temp', {
                    id: file.id
                })
                this.removeFromLRU(file.id)
            } catch (error) {
                await this.ctx.database.remove('chatluna_storage_temp', {
                    id: file.id
                })
                this.removeFromLRU(file.id)
            }
        }
    }

    private async deleteFileFromBackend(file: TempFileInfo): Promise<void> {
        const storageType = file.storageType ?? 'local'

        if (storageType === 'local') {
            // For local files, use fs.unlink with the path
            await fs.unlink(file.path)
        } else {
            // For remote storage, use the current backend if it matches, otherwise create a temporary one
            if (this.storageBackend.type === storageType) {
                await this.storageBackend.delete(file.path)
            } else {
                // If file was stored with a different backend type, we still try to delete from current
                // This handles migration scenarios
                try {
                    await this.storageBackend.delete(file.path)
                } catch {
                    // Ignore errors when deleting from mismatched backend
                }
            }
        }
    }

    private setupAutoDelete() {
        const ctx = this.ctx
        const self = this

        async function execute() {
            if (!ctx.scope.isActive) {
                return
            }

            const expiredFiles = await ctx.database.get(
                'chatluna_storage_temp',
                {
                    expireTime: {
                        $lt: new Date(Date.now())
                    }
                }
            )

            if (expiredFiles.length === 0) {
                return
            }

            const success: TempFileInfo[] = []

            for (const file of expiredFiles) {
                try {
                    await self.deleteFileFromBackend(file)
                    await ctx.database.remove('chatluna_storage_temp', {
                        id: file.id
                    })
                    success.push(file)
                } catch (error) {
                    await ctx.database.remove('chatluna_storage_temp', {
                        id: file.id
                    })
                    success.push(file)
                }
            }

            if (success.length > 0) {
                logger.success(
                    `Auto deleted ${success.length} expired temp files`
                )
            }
        }

        const executeCleanup = async () => {
            if (!ctx.scope.isActive) return
            await this.cleanupByStorageSize()
            await this.cleanupByFileCount()
        }

        execute()
        executeCleanup()

        ctx.setInterval(async () => {
            await execute()
            await executeCleanup()
        }, Time.minute * 5)
    }

    async createTempFile(
        buffer: Buffer,
        filename: string,
        expireHours?: number
    ): Promise<TempFileInfoWithData<Buffer>> {
        const fileType = getImageType(buffer, true, true)

        const processedBuffer = buffer

        let randomName = randomFileName(filename)

        if (fileType != null) {
            // reset randomName type
            randomName =
                (randomName.split('.')?.[0] ?? randomName) + '.' + fileType
        }

        // Upload to storage backend
        const result = await this.storageBackend.upload(processedBuffer, randomName)

        const expireTime =
            new Date(Date.now() +
              (expireHours || this.config.tempCacheTime) * 60 * 60 * 1000)

        const currentTime = new Date()
        const fileInfo: TempFileInfo = {
            id: randomName.split('.')[0],
            path: result.key,
            name: randomName,
            type: fileType,
            expireTime,
            size: processedBuffer.length,
            accessTime: currentTime,
            accessCount: 1,
            storageType: this.storageBackend.type,
            publicUrl: result.publicUrl
        }

        await this.ctx.database.create('chatluna_storage_temp', fileInfo)
        this.addToLRU(fileInfo.id)

        // If backend has public URL, use it; otherwise use local backend path
        const url = result.publicUrl ?? `${this.backendPath}/temp/${randomName}`

        return {
            ...fileInfo,
            data: Promise.resolve(processedBuffer),
            url
        }
    }

    async getTempFile(
        id: string
    ): Promise<TempFileInfoWithData<Buffer> | null> {
        let fileInfo = await this.ctx.database.get('chatluna_storage_temp', {
            id
        })

        if (fileInfo.length === 0) {
            fileInfo = await this.ctx.database.get('chatluna_storage_temp', {
                name: id
            })
        }

        if (fileInfo.length === 0) return null

        const file = fileInfo[0]

        const currentTime = new Date()
        await this.ctx.database.set(
            'chatluna_storage_temp',
            { id: file.id },
            {
                accessTime: currentTime,
                accessCount: file.accessCount + 1
            }
        )

        this.addToLRU(id)

        try {
            // Determine how to download the file based on storage type
            const storageType = file.storageType ?? 'local'
            let dataPromise: Promise<Buffer>

            if (storageType === 'local') {
                // For local files, use the path directly
                dataPromise = fs.readFile(file.path)
            } else if (this.storageBackend.type === storageType) {
                // Use current backend if it matches
                dataPromise = this.storageBackend.download(file.path)
            } else {
                // Fallback: try to read as local file (for backward compatibility)
                dataPromise = fs.readFile(file.path)
            }

            // If file has public URL, use it; otherwise use local backend path
            const url = file.publicUrl ?? `${this.backendPath}/temp/${file.name}`

            return {
                ...file,
                accessTime: currentTime,
                accessCount: file.accessCount + 1,
                data: dataPromise,
                url
            }
        } catch (error) {
            await this.ctx.database.remove('chatluna_storage_temp', { id })
            this.removeFromLRU(id)
            return null
        }
    }
}

declare module 'koishi' {
    interface Context {
        chatluna_storage: ChatLunaStorageService
    }

    interface Tables {
        chatluna_storage_temp: TempFileInfo
    }
}
