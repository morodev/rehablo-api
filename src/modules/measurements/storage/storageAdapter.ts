/**
 * Interfaccia astratta condivisa per la conservazione dei file privati del tenant (misurazioni,
 * logo e documenti paziente). Oggi usa il filesystem locale; resta sostituibile con S3/MinIO
 * senza cambiare i servizi e i controller che la utilizzano.
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
    /** Rimuove un file non più referenziato. L'assenza del file è considerata idempotente. */
    remove(storagePath: string): Promise<void>;
}

