import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    FatturaPaInput,
    buildFatturaPaXml,
    fatturaPaTotal,
    validateFatturaPaInput,
} from './fatturaPa.js';

/** Verifica minima di buona formazione: i tag devono annidarsi correttamente. */
function assertWellFormed(xml: string): void {
    const body = xml.replace(/^<\?xml[^>]*\?>/, '');
    const stack: string[] = [];
    const tagRe = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>/g;
    let match: RegExpExecArray | null;
    while ((match = tagRe.exec(body)) !== null) {
        const [, closing, name, , selfClose] = match;
        if (selfClose) continue;
        if (closing) {
            const top = stack.pop();
            assert.equal(top, name, `Tag di chiusura </${name}> non corrisponde a <${top}>`);
        } else {
            stack.push(name);
        }
    }
    assert.equal(stack.length, 0, `Tag non chiusi: ${stack.join(', ')}`);
}

const b2c = (): FatturaPaInput => ({
    transmission: { senderCountry: 'IT', senderCode: '01234567890', progressivo: '00001', codiceDestinatario: '0000000' },
    cedente: {
        denominazione: 'Studio Fisio Rossi', vatCountry: 'IT', vatNumber: '01234567890', regimeFiscale: 'RF01',
        address: 'Via Roma 1', zip: '06100', city: 'Perugia', province: 'PG', country: 'IT',
    },
    cessionario: {
        nome: 'Mario', cognome: 'Bianchi', taxCode: 'BNCMRA80A01H501U',
        address: 'Via Milano 2', zip: '20100', city: 'Milano', province: 'MI', country: 'IT',
    },
    document: { tipoDocumento: 'TD01', data: '2026-03-15', numero: '12' },
    lines: [{ description: 'Plantare su misura', quantity: 1, unitPrice: 100, vatRate: 22 }],
});

describe('validateFatturaPaInput', () => {
    it('accetta un input B2C completo', () => {
        assert.deepEqual(validateFatturaPaInput(b2c()), []);
    });

    it('richiede la Natura per righe con aliquota 0', () => {
        const input = b2c();
        input.lines = [{ description: 'Prestazione esente', quantity: 1, unitPrice: 100, vatRate: 0 }];
        assert.match(validateFatturaPaInput(input).join(' '), /Natura/);
    });

    it('rifiuta la Natura su righe con aliquota positiva', () => {
        const input = b2c();
        input.lines = [{ description: 'Bene', quantity: 1, unitPrice: 100, vatRate: 22, natura: 'N4' }];
        assert.match(validateFatturaPaInput(input).join(' '), /Natura non va indicata/);
    });

    it('segnala denominazione e nome/cognome insieme', () => {
        const input = b2c();
        input.cessionario = { ...input.cessionario, denominazione: 'X Srl' };
        assert.match(validateFatturaPaInput(input).join(' '), /denominazione OPPURE/);
    });

    it('richiede CodiceDestinatario di 7 caratteri', () => {
        const input = b2c();
        input.transmission.codiceDestinatario = '123';
        assert.match(validateFatturaPaInput(input).join(' '), /7 caratteri/);
    });

    it('richiede sede e identificativo fiscale del cedente', () => {
        const input = b2c();
        input.cedente = { ...input.cedente, vatNumber: null, taxCode: null, zip: null };
        const errors = validateFatturaPaInput(input).join(' ');
        assert.match(errors, /partita IVA o il codice fiscale/);
        assert.match(errors, /CAP/);
    });

    it('richiede data in formato YYYY-MM-DD', () => {
        const input = b2c();
        input.document.data = '15/03/2026';
        assert.match(validateFatturaPaInput(input).join(' '), /YYYY-MM-DD/);
    });
});

describe('fatturaPaTotal', () => {
    it('somma imponibili, imposte e bollo', () => {
        const input = b2c();
        input.lines = [
            { description: 'A', quantity: 2, unitPrice: 50, vatRate: 22 },
            { description: 'B', quantity: 1, unitPrice: 100, vatRate: 0, natura: 'N4' },
        ];
        input.document.bollo = { virtuale: true, importo: 2 };
        // (100 imponibile + 22 imposta) + (100 imponibile + 0) + 2 bollo = 224
        assert.equal(fatturaPaTotal(input), 224);
    });
});

describe('buildFatturaPaXml', () => {
    it('genera XML ben formato con gli elementi chiave', () => {
        const xml = buildFatturaPaXml(b2c());
        assertWellFormed(xml);
        assert.match(xml, /versione="FPR12"/);
        assert.match(xml, /<IdTrasmittente><IdPaese>IT<\/IdPaese><IdCodice>01234567890<\/IdCodice><\/IdTrasmittente>/);
        assert.match(xml, /<CodiceDestinatario>0000000<\/CodiceDestinatario>/);
        assert.match(xml, /<RegimeFiscale>RF01<\/RegimeFiscale>/);
        assert.match(xml, /<Nome>Mario<\/Nome><Cognome>Bianchi<\/Cognome>/);
        assert.match(xml, /<TipoDocumento>TD01<\/TipoDocumento>/);
        assert.match(xml, /<ImportoTotaleDocumento>122\.00<\/ImportoTotaleDocumento>/);
        assert.match(xml, /<AliquotaIVA>22\.00<\/AliquotaIVA>/);
    });

    it('per il B2B include IdFiscaleIVA del cessionario e la PEC', () => {
        const input = b2c();
        input.transmission = { ...input.transmission, codiceDestinatario: '0000000', pecDestinatario: 'ditta@pec.it' };
        input.cessionario = {
            denominazione: 'Palestra Alfa Srl', vatCountry: 'IT', vatNumber: '99999999999',
            address: 'Via Verdi 3', zip: '00100', city: 'Roma', province: 'RM', country: 'IT',
        };
        const xml = buildFatturaPaXml(input);
        assertWellFormed(xml);
        assert.match(xml, /<CessionarioCommittente><DatiAnagrafici><IdFiscaleIVA>/);
        assert.match(xml, /<Denominazione>Palestra Alfa Srl<\/Denominazione>/);
        assert.match(xml, /<PECDestinatario>ditta@pec\.it<\/PECDestinatario>/);
    });

    it('raggruppa il riepilogo per aliquota/natura e calcola l’imposta', () => {
        const input = b2c();
        input.lines = [
            { description: 'A', quantity: 1, unitPrice: 100, vatRate: 22 },
            { description: 'B', quantity: 1, unitPrice: 50, vatRate: 22 },
            { description: 'C', quantity: 1, unitPrice: 80, vatRate: 0, natura: 'N4' },
        ];
        const xml = buildFatturaPaXml(input);
        assertWellFormed(xml);
        // 150 imponibile al 22% → 33 imposta.
        assert.match(xml, /<ImponibileImporto>150\.00<\/ImponibileImporto><Imposta>33\.00<\/Imposta>/);
        assert.match(xml, /<Natura>N4<\/Natura><ImponibileImporto>80\.00<\/ImponibileImporto>/);
    });

    it('genera il bollo virtuale quando presente', () => {
        const input = b2c();
        input.document.bollo = { virtuale: true, importo: 2 };
        const xml = buildFatturaPaXml(input);
        assert.match(xml, /<DatiBollo><BolloVirtuale>SI<\/BolloVirtuale><ImportoBollo>2\.00<\/ImportoBollo><\/DatiBollo>/);
    });

    it('lancia con dettagli se la struttura non è valida', () => {
        const input = b2c();
        input.lines = [];
        assert.throws(() => buildFatturaPaXml(input), /non generabile/);
    });

    it('effettua l’escape dei caratteri speciali XML', () => {
        const input = b2c();
        input.lines = [{ description: 'Tutore & sostegno <lombare>', quantity: 1, unitPrice: 10, vatRate: 22 }];
        const xml = buildFatturaPaXml(input);
        assertWellFormed(xml);
        assert.match(xml, /Tutore &amp; sostegno &lt;lombare&gt;/);
    });
});
