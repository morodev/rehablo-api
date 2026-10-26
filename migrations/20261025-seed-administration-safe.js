'use strict';

const { randomUUID } = require('node:crypto');

function quoteSchema(schema) {
    if (!/^rehablo_[a-f0-9]{32}$/i.test(schema)) throw new Error('Invalid tenant schema');
    return `"${schema}"`;
}

/** Safe configuration seed. Supersedes the unexecuted 20260922 seed without importing historic cash. Existing completed migration records remain valid. */
module.exports = {
    async up(queryInterface, { schema, transaction }) {
        const db = queryInterface.sequelize;
        const prefix = quoteSchema(schema);
        const paymentMethods = [
            ['CASH', 'Contanti', 'CASH', false],
            ['CARD', 'Carta / POS', 'CARD', true],
            ['BANK_TRANSFER', 'Bonifico', 'BANK', true],
            ['OTHER', 'Altro', 'OTHER', true]
        ];
        for (const [code, label, type, traceable] of paymentMethods) {
            await db.query(`INSERT INTO ${prefix}."payment_methods"
                ("id","code","label","type","isTraceable","isActive","createdAt","updatedAt")
                VALUES (:id,:code,:label,:type,:traceable,true,NOW(),NOW())
                ON CONFLICT ("code") DO NOTHING`, {
                transaction, replacements: { id: randomUUID(), code, label, type, traceable }
            });
        }

        const [accountRows] = await db.query(`SELECT "id" FROM ${prefix}."financial_accounts"
            WHERE "type"='CASH' ORDER BY "createdAt" LIMIT 1`, { transaction });
        let accountId = accountRows[0]?.id;
        if (!accountId) {
            accountId = randomUUID();
            await db.query(`INSERT INTO ${prefix}."financial_accounts"
                ("id","structureId","name","type","currency","openingBalance","isActive","metadata","createdAt","updatedAt")
                VALUES (:id,NULL,'Cassa principale','CASH','EUR',0,true,'{}'::jsonb,NOW(),NOW())`, {
                transaction, replacements: { id: accountId }
            });
        }

        const [listRows] = await db.query(`SELECT "id" FROM ${prefix}."price_lists"
            WHERE "code"='STANDARD' LIMIT 1`, { transaction });
        let priceListId = listRows[0]?.id;
        if (!priceListId) {
            priceListId = randomUUID();
            await db.query(`INSERT INTO ${prefix}."price_lists"
                ("id","name","code","audience","priority","isDefault","isActive","createdAt","updatedAt")
                VALUES (:id,'Listino standard','STANDARD','PRIVATE',0,true,true,NOW(),NOW())`, {
                transaction, replacements: { id: priceListId }
            });
        }
        const [versionRows] = await db.query(`SELECT "id" FROM ${prefix}."price_list_versions"
            WHERE "priceListId"=:priceListId AND "version"=1 LIMIT 1`, {
            transaction, replacements: { priceListId }
        });
        let versionId = versionRows[0]?.id;
        if (!versionId) {
            versionId = randomUUID();
            await db.query(`INSERT INTO ${prefix}."price_list_versions"
                ("id","priceListId","version","validFrom","validTo","status","notes","createdAt","updatedAt")
                VALUES (:id,:priceListId,1,'2000-01-01',NULL,'PUBLISHED','Generato dal catalogo esistente',NOW(),NOW())`, {
                transaction, replacements: { id: versionId, priceListId }
            });
        }
        for (const [table, itemType] of [['services', 'SERVICE'], ['products', 'PRODUCT']]) {
            const [rows] = await db.query(`SELECT "id","name","sellingPrice","productVat" FROM ${prefix}."${table}"
                WHERE "sellingPrice" IS NOT NULL`, { transaction });
            for (const row of rows) {
                await db.query(`INSERT INTO ${prefix}."price_list_items"
                    ("id","priceListVersionId","itemType","itemId","description","unitPrice","vatRate","vatNature","structureId","minQuantity","metadata","createdAt","updatedAt")
                    VALUES (:id,:versionId,:itemType,:itemId,:description,:unitPrice,NULL,NULL,NULL,1,'{}'::jsonb,NOW(),NOW())
                    ON CONFLICT ("priceListVersionId","itemType","itemId","structureId") DO NOTHING`, {
                    transaction, replacements: {
                        id: randomUUID(), versionId, itemType, itemId: row.id,
                        description: row.name ?? null, unitPrice: row.sellingPrice
                    }
                });
            }
        }

    }
};
