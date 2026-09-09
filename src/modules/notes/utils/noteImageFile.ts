import path from 'path';

export const NOTE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

export const NOTE_IMAGE_MIME_TYPES = new Set([
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/webp'
]);

const MIME_EXTENSIONS: Record<string, Set<string>> = {
    'image/gif': new Set(['.gif']),
    'image/jpeg': new Set(['.jpeg', '.jpg']),
    'image/png': new Set(['.png']),
    'image/webp': new Set(['.webp'])
};

export function detectNoteImageMime(buffer: Buffer): string | null {
    if (
        buffer.length >= 8
        && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
        return 'image/png';
    }
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg';
    }
    if (
        buffer.length >= 6
        && (buffer.subarray(0, 6).toString('ascii') === 'GIF87a'
            || buffer.subarray(0, 6).toString('ascii') === 'GIF89a')
    ) {
        return 'image/gif';
    }
    if (
        buffer.length >= 12
        && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
        && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
        return 'image/webp';
    }
    return null;
}

export function hasExpectedNoteImageExtension(fileName: string, mimeType: string): boolean {
    const extension = path.extname(fileName.trim()).toLowerCase();
    return MIME_EXTENSIONS[mimeType]?.has(extension) ?? false;
}

interface NoteImageFile {
    buffer: Buffer;
    mimetype: string;
    originalname: string;
}

export function validateNoteImageFile(file: NoteImageFile): string | null {
    const detectedMimeType = detectNoteImageMime(file.buffer);
    if (
        !NOTE_IMAGE_MIME_TYPES.has(file.mimetype)
        || !detectedMimeType
        || detectedMimeType !== file.mimetype
        || !hasExpectedNoteImageExtension(file.originalname, detectedMimeType)
    ) {
        return null;
    }
    return detectedMimeType;
}
