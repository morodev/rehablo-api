import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    StsDocumentoSpesa,
    buildStsTracciato,
    mapInvoiceToStsDocumento,
    stsDocumentoTotale,
    validateStsDocumento,
} from './sistemaTsTracciato.js';

const doc = (over: Partial<StsDocumentoSpesa> = {}): StsDocumentoSpesa => ({
    cfCittadino: 'BNCMRA80A01H501U',
    opposizione: false,
    dataEmissione: '2026-03-15',
    numeroDocumento: '12',
    dataPagamento: '2026-03-15',
    pagamentoTracciato: true,
    pagamentoAnticipato: false,
    voci: [{ tipoSpesa: 'SP', importo: 100 }],
    ...over,
});

describe('validateStsDocumento', () => {
    it('accetta un documento completo', () => {
        assert.deepEqual(validateStsDocumento(doc()), []);
    });
    it('richiede il codice fiscale senza opposizione', () => {
        assert.match(validateStsDocumento(doc({ cfCittadino: null })).join(' '), /Codice fiscale/);
    });
    it('non richiede il codice fiscale con opposizione', () => {
        assert.deepEqual(validateStsDocumento(doc({ cfCittadino: null, opposizione: true })), []);
    });
    it('rifiuta importi non positivi e date non valide', () => {
        assert.match(validateStsDocumento(doc({ voci: [{ tipoSpesa: 'SP', importo: 0 }] })).join(' '), /importo non valido/);
        assert.match(validateStsDocumento(doc({ dataEmissione: '15-03-2026' })).join(' '), /Data di emissione/);
        assert.match(validateStsDocumento(doc({ dataPagamento: 'ieri' })).join(' '), /Data di pagamento/);
    });
    it('richiede almeno una voce', () => {
        assert.match(validateStsDocumento(doc({ voci: [] })).join(' '), /Nessuna voce/);
    });
});

describe('stsDocumentoTotale', () => {
    it('somma gli importi delle voci', () => {
        assert.equal(stsDocumentoTotale(doc({ voci: [{ tipoSpesa: 'SP', importo: 80 }, { tipoSpesa: 'SP', importo: 20.5 }] })), 100.5);
    });
});

describe('buildStsTracciato', () => {
    it('genera il tracciato con dettaglio voce, pagamento e tracciabilità', () => {
        const result = buildStsTracciato({ cfProprietario: '01234567890' }, [doc()], 2026);
        assert.equal(result.transmitted, 1);
        assert.equal(result.opposed, 0);
        assert.deepEqual(result.errors, []);
        assert.match(result.xml, /<cfProprietario>01234567890<\/cfProprietario>/);
        assert.match(result.xml, /<documentiSpesa annoFiscale="2026">/);
        assert.match(result.xml, /<cfCittadino>BNCMRA80A01H501U<\/cfCittadino>/);
        assert.match(result.xml, /<voceSpesa><tipoSpesa>SP<\/tipoSpesa><importo>100\.00<\/importo><\/voceSpesa>/);
        assert.match(result.xml, /<pagamentoTracciato>SI<\/pagamentoTracciato>/);
        assert.match(result.xml, /<dataPagamento>2026-03-15<\/dataPagamento>/);
    });

    it('esclude dalla trasmissione i documenti con opposizione ma li conteggia', () => {
        const result = buildStsTracciato({ cfProprietario: '01234567890' }, [
            doc({ numeroDocumento: '1' }),
            doc({ numeroDocumento: '2', opposizione: true, cfCittadino: null }),
        ], 2026);
        assert.equal(result.transmitted, 1);
        assert.equal(result.opposed, 1);
        assert.doesNotMatch(result.xml, /numeroDocumento>2</);
    });

    it('segnala i documenti non validi senza includerli', () => {
        const result = buildStsTracciato({ cfProprietario: '01234567890' }, [
            doc({ numeroDocumento: '9', voci: [] }),
        ], 2026);
        assert.equal(result.transmitted, 0);
        assert.match(result.errors.join(' '), /Documento 9/);
    });

    it('segnala l’erogatore mancante', () => {
        const result = buildStsTracciato({ cfProprietario: '' }, [doc()], 2026);
        assert.match(result.errors.join(' '), /erogatore/);
    });

    it('omette dataPagamento e usa NO per pagamento non tracciabile', () => {
        const result = buildStsTracciato({ cfProprietario: '01234567890' }, [
            doc({ dataPagamento: null, pagamentoTracciato: false }),
        ], 2026);
        assert.doesNotMatch(result.xml, /dataPagamento/);
        assert.match(result.xml, /<pagamentoTracciato>NO<\/pagamentoTracciato>/);
    });
});

describe('mapInvoiceToStsDocumento', () => {
    const base = {
        invoice: { documentNumber: 12, documentYear: 2026, emissionDate: '2026-03-15' },
        fiscalCode: 'bncmra80a01h501u',
        opposizione: false,
        tipoSpesa: 'SP',
    };

    it('usa l’importo pagato (non il totale fattura) e i dati di pagamento', () => {
        const doc = mapInvoiceToStsDocumento({
            ...base, payment: { paidAmount: 80, paidAt: '2026-04-01', traceable: true },
        });
        assert.equal(doc?.voci[0].importo, 80);
        assert.equal(doc?.cfCittadino, 'BNCMRA80A01H501U');
        assert.equal(doc?.dataPagamento, '2026-04-01');
        assert.equal(doc?.pagamentoTracciato, true);
        assert.deepEqual(validateStsDocumento(doc!), []);
    });

    it('restituisce null se non c’è importo pagato', () => {
        assert.equal(mapInvoiceToStsDocumento({ ...base, payment: { paidAmount: 0, paidAt: null, traceable: false } }), null);
    });
});
