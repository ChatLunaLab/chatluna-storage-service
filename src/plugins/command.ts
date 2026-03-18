import { randomBytes } from 'crypto'
import { Readable } from 'stream'
import { Context } from 'koishi'
import { Config, logger } from '../index.js'
import type {} from '../service/storage.js'
import type { TempFileInfoWithData } from '../types.js'

interface StorageTestResult {
    method: string
    success: boolean
    cleanup: 'success' | 'skipped' | 'failed'
    fetch: 'success' | 'failed' | 'skipped'
    size?: number
    fileId?: string
    url?: string
    httpStatus?: number
    error?: string
}

export function apply(ctx: Context, config: Config) {
    ctx.inject(['chatluna_storage'], (ctx) => {
        ctx.command('chatluna.storage', 'ChatLuna 存储相关命令')

        ctx.command(
            'chatluna.storage.test',
            '测试存储后端的直接上传和流式上传'
        ).action(async () => {
            const token = randomBytes(4).toString('hex')

            const [directResult, streamResult] = await Promise.all([
                runUploadTest(
                    ctx,
                    '直接上传',
                    'direct',
                    `Hello world direct-${token}`,
                    async (buffer, filename) =>
                        ctx.chatluna_storage.createTempFile(
                            buffer,
                            filename,
                            1,
                            'text/plain'
                        )
                ),
                runUploadTest(
                    ctx,
                    '流式上传',
                    'stream',
                    `Hello world stream-${token}`,
                    async (buffer, filename) =>
                        ctx.chatluna_storage.createTempFileFromStream(
                            Readable.from([buffer]),
                            filename,
                            {
                                expireHours: 1,
                                mimeType: 'text/plain',
                                size: buffer.length
                            }
                        )
                )
            ])

            return formatResults(config.storageBackend, [
                directResult,
                streamResult
            ])
        })
    })
}

async function runUploadTest(
    ctx: Context,
    method: string,
    slug: string,
    content: string,
    upload: (
        buffer: Buffer,
        filename: string
    ) => Promise<TempFileInfoWithData<Buffer>>
): Promise<StorageTestResult> {
    const buffer = Buffer.from(content, 'utf8')
    const filename = `storage-${slug}-${randomBytes(4).toString('hex')}.txt`
    let fileId: string | undefined
    let cleanup: StorageTestResult['cleanup'] = 'skipped'
    let access: Pick<StorageTestResult, 'fetch' | 'httpStatus' | 'url'> = {
        fetch: 'skipped'
    }

    try {
        const created = await upload(buffer, filename)
        fileId = created.id
        access.url = created.url

        await assertFileContent(created, buffer, '创建后返回的文件')

        try {
            access = await assertFetchContent(
                created.url,
                buffer,
                '上传后的访问地址'
            )
        } catch (error) {
            access.fetch = 'failed'
            throw error
        }

        const fetched = await ctx.chatluna_storage.getTempFile(created.id)

        if (!fetched) {
            throw new Error('上传后无法重新读取文件')
        }

        await assertFileContent(fetched, buffer, '重新读取的文件')

        const deleted = await ctx.chatluna_storage.deleteTempFile(created.id)

        if (!deleted) {
            throw new Error('上传成功，但删除失败')
        }

        cleanup = 'success'

        const afterDelete = await ctx.chatluna_storage.getTempFile(created.id)

        if (afterDelete) {
            throw new Error('文件删除后仍然可以读取')
        }

        return {
            method,
            success: true,
            cleanup,
            fetch: access.fetch,
            size: created.size,
            fileId,
            url: access.url,
            httpStatus: access.httpStatus
        }
    } catch (error) {
        if (access.url && access.fetch === 'skipped') {
            access.fetch = 'failed'
        }

        if (cleanup !== 'success' && fileId) {
            cleanup = (await ctx.chatluna_storage
                .deleteTempFile(fileId)
                .catch(() => false))
                ? 'success'
                : 'failed'
        }

        logger.error(`storage ${slug} upload test failed`, error)

        return {
            method,
            success: false,
            cleanup,
            fetch: access.fetch,
            fileId,
            url: access.url,
            httpStatus: access.httpStatus,
            error: error instanceof Error ? error.message : String(error)
        }
    }
}

async function assertFileContent(
    file: TempFileInfoWithData<Buffer>,
    expected: Buffer,
    label: string
) {
    if (file.size !== expected.length) {
        throw new Error(
            `${label}大小不匹配，期望 ${expected.length} B，实际 ${file.size} B`
        )
    }

    const payload = await file.data

    if (!payload.equals(expected)) {
        throw new Error(`${label}内容不匹配`)
    }
}

async function assertFetchContent(
    url: string,
    expected: Buffer,
    label: string
): Promise<Pick<StorageTestResult, 'fetch' | 'httpStatus' | 'url'>> {
    const response = await fetch(url)

    if (!response.ok) {
        throw new Error(
            `${label}失败，HTTP 状态码 ${response.status}`
        )
    }

    const payload = Buffer.from(await response.arrayBuffer())

    if (!payload.equals(expected)) {
        throw new Error(`${label}返回内容不匹配`)
    }

    return {
        fetch: 'success',
        httpStatus: response.status,
        url
    }
}

function formatResults(
    backend: Config['storageBackend'],
    results: StorageTestResult[]
) {
    const successCount = results.filter((result) => result.success).length
    const sections = [
        '存储后端测试结果',
        `当前后端：${backend}`,
        `总体结果：${successCount}/${results.length} 项成功`
    ]

    for (const result of results) {
        const lines = [
            result.method,
            `状态：${result.success ? '成功' : '失败'}`,
            `文件大小：${result.size ?? '未知'} B`,
            `fetch 访问：${formatFetch(result.fetch)}`,
            `清理结果：${formatCleanup(result.cleanup)}`
        ]

        if (result.fileId) {
            lines.push(`文件 ID：${result.fileId}`)
        }

        if (result.httpStatus != null) {
            lines.push(`HTTP 状态：${result.httpStatus}`)
        }

        if (result.url) {
            lines.push(`访问地址：${result.url}`)
        }

        if (result.error) {
            lines.push(`错误信息：${result.error}`)
        }

        sections.push(lines.join('\n'))
    }

    return sections.join('\n\n')
}

function formatCleanup(status: StorageTestResult['cleanup']) {
    switch (status) {
        case 'success':
            return '成功'
        case 'failed':
            return '失败'
        default:
            return '跳过'
    }
}

function formatFetch(status: StorageTestResult['fetch']) {
    switch (status) {
        case 'success':
            return '成功'
        case 'failed':
            return '失败'
        default:
            return '跳过'
    }
}
