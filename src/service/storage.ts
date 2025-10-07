import { Context, Service, Time } from 'koishi'
import { Config, logger } from '..'
import { TempFileInfo, TempFileInfoWithData } from '../types'
import { getImageType, randomFileName } from '../utils'
import { join } from 'path'
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
                expireTime: 'integer',
                size: 'integer',
                accessTime: 'integer',
                accessCount: 'integer'
            },
            {
                autoInc: false,
                primary: 'id'
            }
        )

        this.setupAutoDelete()
        this.initializeLRU()

        ctx.inject(['server'], (ctx) => {
            const backendPath = `${config.serverPath ?? ctx.server.selfUrl}${this.config.backendPath}`
            this.backendPath = backendPath
        })
    }

    private async initializeLRU() {
        const files = await this.ctx.database.get('chatluna_storage_temp', {})
        files.sort((a, b) => b.accessTime - a.accessTime)
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

        const sortedFiles = files.sort((a, b) => a.accessTime - b.accessTime)
        let currentSize = totalSize

        for (const file of sortedFiles) {
            if (currentSize <= maxSizeBytes * 0.8) break

            try {
                await fs.unlink(file.path)
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

        const sortedFiles = files.sort((a, b) => a.accessTime - b.accessTime)
        const filesToDelete =
            files.length - Math.floor(this.config.maxStorageCount * 0.8)

        for (let i = 0; i < filesToDelete; i++) {
            const file = sortedFiles[i]
            try {
                await fs.unlink(file.path)
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

    private setupAutoDelete() {
        const ctx = this.ctx

        async function execute() {
            if (!ctx.scope.isActive) {
                return
            }

            const expiredFiles = await ctx.database.get(
                'chatluna_storage_temp',
                {
                    expireTime: {
                        $lt: Date.now()
                    }
                }
            )

            if (expiredFiles.length === 0) {
                return
            }

            const success: TempFileInfo[] = []

            for (const file of expiredFiles) {
                try {
                    await fs.unlink(file.path)
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

        const filePath = join(this.config.storagePath, 'temp', randomName)

        await fs.mkdir(join(this.config.storagePath, 'temp'), {
            recursive: true
        })
        await fs.writeFile(filePath, processedBuffer)

        const expireTime =
            Date.now() +
            (expireHours || this.config.tempCacheTime) * 60 * 60 * 1000

        const currentTime = Date.now()
        const fileInfo: TempFileInfo = {
            id: randomName.split('.')[0],
            path: filePath,
            name: randomName,
            type: fileType,
            expireTime,
            size: processedBuffer.length,
            accessTime: currentTime,
            accessCount: 1
        }

        await this.ctx.database.create('chatluna_storage_temp', fileInfo)
        this.addToLRU(fileInfo.id)

        return {
            ...fileInfo,
            data: Promise.resolve(processedBuffer),
            url: `${this.backendPath}/temp/${randomName}`
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

        const currentTime = Date.now()
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
            return {
                ...file,
                accessTime: currentTime,
                accessCount: file.accessCount + 1,
                data: fs.readFile(file.path),
                url: `${this.backendPath}/temp/${file.name}`
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
