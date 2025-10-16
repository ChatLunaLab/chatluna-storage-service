export interface TempFileInfo {
    path: string
    name: string
    type?: string
    expireTime: Date
    id: string
    size: number
    accessTime: Date
    accessCount: number
}

export interface TempFileInfoWithData<T> extends TempFileInfo {
    data: Promise<T>
    url: string
}
