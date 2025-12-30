/* eslint-disable @typescript-eslint/no-namespace */
/* eslint-disable max-len */
import { Context, Logger, Schema } from 'koishi'

import { plugins } from './plugins'
import { ChatLunaStorageService } from './service/storage'

export * from './service/storage'
export let logger: Logger

export const usage = `使用此插件需要确保你 Koishi 运行在公网，或你的聊天适配器（如 onebot，telegram）和 koishi 运行在同一个局域网中。

不同的存储后端的作用：
- **本地文件**：默认选项，文件存储在本地磁盘，通过 Koishi 的 HTTP 服务器提供访问
- **S3 兼容存储**：支持 AWS S3、MinIO 等 S3 兼容服务，可配置公网 URL 直接访问
- **WebDAV**：支持 WebDAV 协议的存储服务
- **Cloudflare R2**：Cloudflare 的对象存储服务，S3 兼容

如果存储后端支持公网访问（配置了公网 URL），系统会直接返回公网 URL，不经过 Koishi 服务器中转。`

export function apply(ctx: Context, config: Config) {
    ctx.on('ready', async () => {
        ctx.plugin(ChatLunaStorageService, config)
        logger = ctx.logger('chatluna-storage-service')
        await plugins(ctx, config)
    })
}

export const inject = {
    required: ['chatluna', 'database']
}

export type StorageBackendType = 'local' | 's3' | 'webdav' | 'r2'

export interface Config {
    // Base config
    backendPath?: string
    storagePath?: string
    serverPath: string
    tempCacheTime: number
    maxStorageSize: number
    maxStorageCount: number

    // Storage backend selection
    storageBackend: StorageBackendType

    // S3 config
    s3Endpoint?: string
    s3Bucket?: string
    s3Region?: string
    s3AccessKeyId?: string
    s3SecretAccessKey?: string
    s3PublicUrl?: string
    s3PathStyle?: boolean

    // WebDAV config
    webdavEndpoint?: string
    webdavUsername?: string
    webdavPassword?: string
    webdavBasePath?: string
    webdavPublicUrl?: string

    // R2 config
    r2AccountId?: string
    r2Bucket?: string
    r2AccessKeyId?: string
    r2SecretAccessKey?: string
    r2PublicUrl?: string
}

export const Config: Schema<Config> = Schema.intersect([
    Schema.object({
        storageBackend: Schema.union([
            Schema.const('local').description('本地文件存储'),
            Schema.const('s3').description('S3 兼容存储 (AWS S3, MinIO 等)'),
            Schema.const('webdav').description('WebDAV 存储'),
            Schema.const('r2').description('Cloudflare R2 存储')
        ])
            .default('local')
            .description('存储后端类型'),

        serverPath: Schema.string()
            .description('Koishi 在公网或者局域网中的路径')
            .default('http://127.0.0.1:5140'),

        tempCacheTime: Schema.number()
            .description('过期数据的缓存时间（小时）')
            .default(24 * 30),
        maxStorageSize: Schema.number()
            .description('最大存储空间（MB）')
            .default(500)
            .min(1),
        maxStorageCount: Schema.number()
            .description('最大存储文件数')
            .default(300)
            .min(1)
    }).description('基础配置'),

    Schema.union([
        Schema.object({
            storageBackend: Schema.const('s3').required(),
            s3Endpoint: Schema.string().description(
                'S3 端点 URL（如 https://s3.amazonaws.com）'
            ),
            s3Bucket: Schema.string().description('S3 存储桶名称'),
            s3Region: Schema.string()
                .description('S3 区域（如 us-east-1）')
                .default('us-east-1'),
            s3AccessKeyId: Schema.string().description('S3 Access Key ID'),
            s3SecretAccessKey: Schema.string()
                .description('S3 Secret Access Key')
                .role('secret'),
            s3PublicUrl: Schema.string().description(
                'S3 公网访问 URL（可选，如果配置则直接返回公网 URL）'
            ),
            s3PathStyle: Schema.boolean()
                .description('使用路径风格 URL（用于 MinIO 等）')
                .default(false)
        }).description('S3 配置'),

        Schema.object({
            storageBackend: Schema.const('webdav').required(),
            webdavEndpoint: Schema.string().description('WebDAV 服务器地址'),
            webdavUsername: Schema.string().description('WebDAV 用户名'),
            webdavPassword: Schema.string()
                .description('WebDAV 密码')
                .role('secret'),
            webdavBasePath: Schema.string()
                .description('WebDAV 基础路径')
                .default('chatluna-storage'),
            webdavPublicUrl: Schema.string().description(
                'WebDAV 公网访问 URL（可选）'
            )
        }).description('WebDAV 配置'),

        Schema.object({
            storageBackend: Schema.const('r2').required(),
            r2AccountId: Schema.string().description('Cloudflare 账户 ID'),
            r2Bucket: Schema.string().description('R2 存储桶名称'),
            r2AccessKeyId: Schema.string().description('R2 Access Key ID'),
            r2SecretAccessKey: Schema.string()
                .description('R2 Secret Access Key')
                .role('secret'),
            r2PublicUrl: Schema.string().description(
                'R2 公网访问 URL（需在 Cloudflare 配置公共访问）'
            )
        }).description('Cloudflare R2 配置'),

        Schema.object({
            storageBackend: Schema.const('local').required(),
            storagePath: Schema.path({
                filters: ['directory']
            })
                .description('本地缓存存储路径（仅本地存储使用）')
                .default('./data/chatluna-storage'),
            backendPath: Schema.string()
                .description('后端文件服务器监听的路径')
                .default('/chatluna-storage')
        }).description('本地存储配置'),
        Schema.object({})
    ])
]) as any

export const name = 'chatluna-storage-service'
