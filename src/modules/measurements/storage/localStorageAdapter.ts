import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { env } from '../../../config/env.js';
import type { SavedFileMeta, StorageAdapter } from './storageAdapter.js';

/**
 * Implementazione filesystem locale dello `StorageAdapter` (F0.1). Organizza i file per
 * `<tenantId>/<yyyy>/<mm>/<uuid>.<ext>` sotto `env.rawFileStorageDir`. Adatta per sviluppo/self-hosted;
 * sostituibile in futuro da un adapter S3/MinIO implementando la stessa interfaccia.
 */
export class LocalStorageAdapter implements StorageAdapter {
    constructor(private readonly baseDir: string = env.rawFileStorageDir) {}

    async save(tenantId: string, buffer: Buffer, originalName: string): Promise<SavedFileMeta> {
        const now = new Date();
        const yyyy = String(now.getFullYear());
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dir = path.join(this.baseDir, tenantId, yyyy, mm);
        await fs.mkdir(dir, { recursive: true });

        const checksumSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        const ext = path.extname(originalName || '');
        const fileName = `${crypto.randomUUID()}${ext}`;
        const fullPath = path.join(dir, fileName);
        await fs.writeFile(fullPath, buffer);

        // Percorso relativo alla root dello storage: portabile, non dipende dall'ambiente/deploy.
        const storagePath = path.relative(this.baseDir, fullPath).split(path.sep).join('/');
        return { storagePath, checksumSha256, sizeBytes: buffer.length };
    }

    async read(storagePath: string): Promise<Buffer> {
        const fullPath = path.join(this.baseDir, storagePath);
        return fs.readFile(fullPath);
    }
}

/** Istanza condivisa, usata dal servizio RawFile. */
export const localStorageAdapter: StorageAdapter = new LocalStorageAdapter();

