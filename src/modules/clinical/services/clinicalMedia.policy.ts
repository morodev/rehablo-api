import {fail} from './clinical.policy.js';

export function detectClinicalMime(buffer: Buffer): string | null {
    if (buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) return 'application/pdf';
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
    if (buffer.length >= 12 && buffer.toString('ascii',0,4) === 'RIFF' && buffer.toString('ascii',8,12) === 'WEBP') return 'image/webp';
    if (buffer.length >= 12 && buffer.toString('ascii',4,8) === 'ftyp') {
        const brand = buffer.toString('ascii',8,12);
        if (['isom','iso2','mp41','mp42','avc1','M4V ','qt  '].includes(brand)) return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
    }
    if (buffer.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])) && buffer.subarray(0,256).includes(Buffer.from('webm'))) return 'video/webm';
    return null;
}

export function clinicalFilename(name: string): string {
    return name.split(/[\\/]/).pop()!.replace(/[\x00-\x1f\x7f]/g, '').slice(0,180) || 'documento';
}

export function validateHomeFeedback(input: any): {status: string; pain: number|null; effort: number|null; notes: string|null; source: 'PATIENT'} {
    if (!input || !['PERFORMED','PARTIAL','NOT_PERFORMED'].includes(input.status)) fail('Indica lo stato della attività');
    const intensity = (value: unknown, label: string) => {
        if (value === undefined || value === null) return null;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) fail(label + ': inserisci un valore tra 0 e 10');
        return value as number;
    };
    if (input.notes !== undefined && input.notes !== null && (typeof input.notes !== 'string' || input.notes.length > 4000)) fail('Nota non valida');
    return {status: input.status, pain: intensity(input.pain,'Dolore'), effort: intensity(input.effort,'Sforzo'), notes: input.notes?.trim() || null, source: 'PATIENT'};
}

export function canPublishClinicalRecord(record: {kind: string; status: string}): boolean {
    return ['PROGRAM','REPORT','DOCUMENT'].includes(record.kind) && record.status === 'CONFIRMED';
}

/** Only explicitly public fields can cross the patient boundary. */
export function publicClinicalData(kind: string, data: Record<string,any>): Record<string,any> {
    if (kind === 'REPORT') return {text: data.text};
    if (kind === 'DOCUMENT') return {documentType: data.documentType,fileName: data.fileName,mimeType: data.mimeType};
    if (kind === 'PROGRAM') return {
        discipline: data.discipline, instructions: data.instructions, frequency: data.frequency,
        items: (data.items ?? []).map((item: Record<string,any>) => Object.fromEntries(
            ['id','category','title','day','block','side','sets','reps','durationSeconds','distance','load','loadUnit','loadMode','loadDescription','restSeconds','instructions']
                .filter(key => item[key] !== undefined).map(key => [key,item[key]])))
    };
    return {};
}
