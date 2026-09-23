import { randomUUID } from 'node:crypto';
import { Transaction } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface InvoicePaymentTreasuryContext {
    accountId: string;
    structureId: string;
    paymentMethodId: string | null;
    idempotencyKey?: string | null;
}
export interface InvoicePaymentCreateOptions {
    transaction?: Transaction;
    treasuryContext?: InvoicePaymentTreasuryContext;
}

interface PaymentSnapshot {
    id: string;
    invoiceId?: string | null;
    agendaEventId?: string | null;
    amount: number;
    paidAt?: Date | string | null;
    method?: string | null;
    note?: string | null;
    createdByUserId?: string | null;
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
    const prefix = schemaPrefix(schema);
    if (!prefix) return;
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
    if (!structureId) return;

    let accountId = context?.accountId;
    if (!accountId) {
        const [accountRows] = await sequelize.query(`SELECT "id" FROM ${prefix}."financial_accounts"
            WHERE "isActive"=true AND ("structureId"=:structureId OR "structureId" IS NULL)
            ORDER BY ("structureId" IS NOT NULL) DESC, "createdAt" ASC LIMIT 1`, {
            transaction, replacements: { structureId }
        });
        accountId = (accountRows[0] as { id?: string } | undefined)?.id;
    }
    if (!accountId) return;

    await sequelize.query(`INSERT INTO ${prefix}."treasury_movements"
        ("id","accountId","structureId","direction","category","amount","occurredAt","status",
         "counterparty","description","invoiceId","sourceType","sourceId","createdByUserId","paymentMethodId","idempotencyKey","createdAt","updatedAt")
        VALUES (:id,:accountId,:structureId,'IN','INVOICE_PAYMENT',:amount,:occurredAt,'POSTED',NULL,
                :description,:invoiceId,'INVOICE_PAYMENT',:sourceId,:createdByUserId,:paymentMethodId,:idempotencyKey,NOW(),NOW())
        ON CONFLICT ("sourceType","sourceId") DO NOTHING`, {
        transaction,
        replacements: {
            id: randomUUID(), accountId, structureId, amount: payment.amount,
            occurredAt: payment.paidAt ?? new Date(), description: payment.note ?? payment.method ?? null,
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
    const prefix = schemaPrefix(schema);
    if (!prefix) return;
    await sequelize.query(`INSERT INTO ${prefix}."treasury_movements"
        ("id","accountId","structureId","direction","category","amount","occurredAt","status",
         "counterparty","description","invoiceId","sourceType","sourceId","createdByUserId","reversalOfId","createdAt","updatedAt")
        SELECT :id, original."accountId", original."structureId", 'OUT', 'PAYMENT_VOID', original."amount", NOW(),
               'POSTED', original."counterparty", 'Storno incasso', original."invoiceId", 'INVOICE_PAYMENT_VOID',
               :sourceId, :createdByUserId, original."id", NOW(), NOW()
        FROM ${prefix}."treasury_movements" original
        WHERE original."sourceType"='INVOICE_PAYMENT' AND original."sourceId"=:sourceId
        ON CONFLICT ("sourceType","sourceId") DO NOTHING`, {
        transaction,
        replacements: { id: randomUUID(), sourceId: payment.id, createdByUserId: payment.createdByUserId ?? null }
    });
}
