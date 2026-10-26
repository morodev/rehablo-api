import { randomUUID } from 'node:crypto';
import { Transaction } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import {resolveFinancialAccount} from './financialAccountResolver.service.js';
import {treasuryError} from './treasuryValidation.service.js';

export interface InvoicePaymentTreasuryContext {
    accountId?: string;
    structureId: string;
    paymentMethodId: string | null;
    idempotencyKey?: string | null;
}
export interface InvoicePaymentCreateOptions {
    transaction?: Transaction;
    treasuryContext?: InvoicePaymentTreasuryContext;
}

interface PaymentSnapshot {
    source?: string;
    id: string;
    invoiceId?: string | null;
    agendaEventId?: string | null;
    amount: number;
    paidAt?: Date | string | null;
    method?: string | null;
    note?: string | null;
    createdByUserId?: string | null;
    voidedByUserId?: string | null;
}

function schemaPrefix(schema: unknown): string | null {
    if (typeof schema !== 'string' || !/^rehablo_[a-f0-9]{32}$/i.test(schema)) return null;
    return `"${schema}"`;
}

export async function mirrorInvoicePaymentToTreasury(
    schema: unknown,
    payment: PaymentSnapshot,
    transaction?: Transaction,
    context?: InvoicePaymentTreasuryContext
): Promise<void> {
    if (['OPENING_BALANCE', 'LEGACY_IMPORT', 'CREDIT', 'PACKAGE'].includes(payment.source ?? '')) return;
    if (!transaction) treasuryError('L’incasso richiede una transazione contabile', 500);
    const prefix = schemaPrefix(schema);
    if (!prefix) treasuryError('Schema finanziario non valido', 500);
    if (!payment.paidAt || !Number.isFinite(new Date(payment.paidAt).getTime()) || !(Number(payment.amount) > 0))
        treasuryError('Data e importo dell’incasso devono essere validi', 422);
    let structureId = context?.structureId;
    if (!structureId) {
        const [structureRows] = await sequelize.query(`SELECT COALESCE(i."structureId", a."structureId") AS "structureId"
            FROM (SELECT CAST(:invoiceId AS uuid) AS "invoiceId", CAST(:agendaEventId AS uuid) AS "agendaEventId") x
            LEFT JOIN ${prefix}."invoices" i ON i."id"=x."invoiceId"
            LEFT JOIN ${prefix}."agenda_events" a ON a."id"=x."agendaEventId"`, {
            transaction, replacements: { invoiceId: payment.invoiceId ?? null, agendaEventId: payment.agendaEventId ?? null }
        });
        structureId = (structureRows[0] as { structureId?: string } | undefined)?.structureId;
    }
    if (!structureId) treasuryError('La sede dell’incasso non è disponibile', 422);
    const accountId = await resolveFinancialAccount(String(schema), structureId, context?.accountId, transaction);

    await sequelize.query(`INSERT INTO ${prefix}."treasury_movements"
        ("id","accountId","structureId","direction","category","amount","occurredAt","status",
         "counterparty","description","invoiceId","sourceType","sourceId","createdByUserId","paymentMethodId","idempotencyKey","createdAt","updatedAt")
        VALUES (:id,:accountId,:structureId,'IN','INVOICE_PAYMENT',:amount,:occurredAt,'POSTED',NULL,
                :description,:invoiceId,'INVOICE_PAYMENT',:sourceId,:createdByUserId,:paymentMethodId,:idempotencyKey,NOW(),NOW())
        ON CONFLICT ("sourceType","sourceId") DO NOTHING`, {
        transaction,
        replacements: {
            id: randomUUID(), accountId, structureId, amount: payment.amount,
            occurredAt: payment.paidAt, description: payment.note ?? payment.method ?? null,
            invoiceId: payment.invoiceId ?? null, sourceId: payment.id,
            createdByUserId: payment.createdByUserId ?? null,
            paymentMethodId: context?.paymentMethodId ?? null, idempotencyKey: context?.idempotencyKey ?? null
        }
    });
}

export async function mirrorVoidedInvoicePaymentToTreasury(
    schema: unknown,
    payment: PaymentSnapshot,
    transaction?: Transaction
): Promise<void> {
    if (['OPENING_BALANCE', 'CREDIT', 'PACKAGE'].includes(payment.source ?? '')) return;
    if (!transaction) treasuryError('Lo storno richiede una transazione contabile', 500);
    const prefix = schemaPrefix(schema);
    if (!prefix) treasuryError('Schema finanziario non valido', 500);
    const [originals] = await sequelize.query(`SELECT "id" FROM ${prefix}."treasury_movements"
        WHERE "sourceType" IN ('INVOICE_PAYMENT_CORRECTION','INVOICE_PAYMENT') AND "sourceId"=:sourceId AND "status"='POSTED'
        ORDER BY CASE WHEN "sourceType"='INVOICE_PAYMENT_CORRECTION' THEN 0 ELSE 1 END LIMIT 1 FOR UPDATE`,
        {transaction, replacements: {sourceId: payment.id}});
    if (!originals.length && payment.source === 'LEGACY_IMPORT') return;
    if (!originals.length) treasuryError('L’incasso non ha un movimento contabile da stornare: completa prima la riconciliazione', 409);
    await sequelize.query(`INSERT INTO ${prefix}."treasury_movements"
        ("id","accountId","structureId","direction","category","amount","occurredAt","status",
         "counterparty","description","invoiceId","sourceType","sourceId","createdByUserId","reversalOfId","createdAt","updatedAt")
        SELECT :id, original."accountId", original."structureId", 'OUT', 'PAYMENT_VOID', original."amount", NOW(),
               'POSTED', original."counterparty", 'Storno incasso', original."invoiceId", 'INVOICE_PAYMENT_VOID',
               :sourceId, :createdByUserId, original."id", NOW(), NOW()
        FROM ${prefix}."treasury_movements" original
        WHERE original."id"=:originalId
        ON CONFLICT ("sourceType","sourceId") DO NOTHING`, {
        transaction,
        replacements: { id: randomUUID(), sourceId: payment.id, originalId: (originals[0] as {id:string}).id,
            createdByUserId: payment.voidedByUserId ?? null }
    });
}
