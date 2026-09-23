import crypto from 'node:crypto';

export interface FiscalGatewayRequest {
    channel: 'STS' | 'SDI';
    documentId: string;
    payload: Record<string, unknown>;
}

export interface FiscalGatewayResult {
    status: 'ACCEPTED' | 'REJECTED';
    externalId: string;
    protocolNumber?: string;
    error?: string;
}

export interface FiscalGateway {
    readonly provider: string;
    readonly sandbox: boolean;
    submit(request: FiscalGatewayRequest): Promise<FiscalGatewayResult>;
}

/** Adapter deterministico per sviluppo e collaudo. Non comunica con STS o SDI. */
export class MockFiscalGateway implements FiscalGateway {
    readonly provider = 'MOCK';
    readonly sandbox = true;

    async submit(request: FiscalGatewayRequest): Promise<FiscalGatewayResult> {
        const digest = crypto.createHash('sha256')
            .update(`${request.channel}:${request.documentId}:${JSON.stringify(request.payload)}`)
            .digest('hex').slice(0, 16).toUpperCase();
        if (request.payload['scenario'] === 'REJECTED' || request.payload['forceReject'] === true) {
            return { status: 'REJECTED', externalId: `MOCK-${digest}`, error: 'Rifiuto simulato scelto per questa prova. Nessun dato è stato trasmesso.' };
        }
        return {
            status: 'ACCEPTED',
            externalId: `MOCK-${digest}`,
            protocolNumber: `SANDBOX-${request.channel}-${digest}`
        };
    }
}

export function fiscalGateway(): FiscalGateway {
    return new MockFiscalGateway();
}
