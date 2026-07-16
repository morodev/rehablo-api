import RawFile from '../models/rawFile.model.js';
import { localStorageAdapter } from '../storage/localStorageAdapter.js';

export interface SaveRawFileInput {
    tenantId: string;
    originalName: string;
    mimeType: string;
    buffer: Buffer;
    uploadedBy?: string | null;
}

/** Salva il file sullo storage (F0.1) e la riga di metadata associata, tenant-scoped. */
export async function saveRawFile(schema: string, input: SaveRawFileInput): Promise<RawFile> {
    const saved = await localStorageAdapter.save(input.tenantId, input.buffer, input.originalName);

    return RawFile.schema(schema).create({
        tenantId: input.tenantId,
        originalName: input.originalName,
        mimeType: input.mimeType,
        sizeBytes: saved.sizeBytes,
        checksumSha256: saved.checksumSha256,
        storagePath: saved.storagePath,
        uploadedBy: input.uploadedBy ?? null
    });
}

export async function getRawFileById(schema: string, id: string): Promise<RawFile | null> {
    return RawFile.schema(schema).findByPk(id);
}

/** Rilegge il contenuto originale di un RawFile già salvato. */
export async function readRawFileBuffer(rawFile: RawFile): Promise<Buffer> {
    return localStorageAdapter.read(rawFile.storagePath);
}

