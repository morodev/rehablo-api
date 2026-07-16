/**
 * Interfaccia astratta per la conservazione dei file grezzi (RawFile). Vedi
 * docs/REHABLO_OS_IMPLEMENTATION_PLAN.md (F0.1): oggi implementata su filesystem locale
 * (`LocalStorageAdapter`), domani sostituibile con un adapter S3/MinIO senza toccare il resto
 * del modulo (servizi/controller dipendono solo da questa interfaccia).
 */
export interface SavedFileMeta {
    /** Percorso RELATIVO alla root dello storage (portabile tra ambienti/adapter diversi). */
    storagePath: string;
    checksumSha256: string;
    sizeBytes: number;
}

export interface StorageAdapter {
    /** Salva il buffer per il tenant indicato e ritorna i metadata necessari a ricostruirlo. */
    save(tenantId: string, buffer: Buffer, originalName: string): Promise<SavedFileMeta>;
    /** Rilegge il contenuto originale dato lo `storagePath` salvato in precedenza. */
    read(storagePath: string): Promise<Buffer>;
}

