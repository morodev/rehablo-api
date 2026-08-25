import { QueryTypes } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { DEFAULT_ROLE, RoleCode } from './roles.js';

/** Numero di righe modificate da una UPDATE eseguita con `QueryTypes.UPDATE`. */
function affectedRows(result: unknown): number {
    return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
}

/**
 * Marca il titolare degli studi in cui nessun utente risulta tale.
 *
 * Fino alla correzione di `createTenant`, l'utente nato dalla registrazione veniva creato
 * senza `isTenant = true` e senza ruolo esplicito sulla membership: si ritrovava quindi
 * `THERAPIST`, cioè senza accesso a fatturazione, gestione utenti e dati azienda.
 *
 * Il titolare viene riconosciuto come il PRIMO utente entrato nel tenant: è per definizione
 * quello che lo ha creato in fase di registrazione.
 *
 * Idempotente: gli studi che hanno già un titolare vengono ignorati.
 */
async function markMissingTenantOwners(): Promise<number> {
    const result = await sequelize.query(
        `WITH founders AS (
             SELECT DISTINCT ON (tu."tenantId") tu."userId"
               FROM tenant_users tu
               JOIN users u ON u.id = tu."userId"
              WHERE tu."tenantId" NOT IN (
                      SELECT tu2."tenantId"
                        FROM tenant_users tu2
                        JOIN users u2 ON u2.id = tu2."userId"
                       WHERE u2."isTenant" = true
                    )
              ORDER BY tu."tenantId", u."createdAt" ASC, u.id ASC
         )
         UPDATE users u
            SET "isTenant" = true
           FROM founders f
          WHERE u.id = f."userId"`,
        { type: QueryTypes.UPDATE }
    );

    return affectedRows(result);
}

/**
 * Ripristina l'invariant OWNER -> tutte le sedi per i dati creati prima della regola.
 * L'INSERT è idempotente e non modifica eventuali override già presenti.
 */
async function assignOwnersToAllStructures(): Promise<number> {
    const inserted = await sequelize.query<{ inserted: number }>(
        `INSERT INTO structure_users ("structureId", "userId", role, "createdAt", "updatedAt")
         SELECT s.id, tu."userId", NULL, NOW(), NOW()
           FROM tenant_users tu
           JOIN structures s ON s."tenantId" = tu."tenantId"
           LEFT JOIN structure_users su
             ON su."structureId" = s.id
            AND su."userId" = tu."userId"
          WHERE tu.role = :ownerRole
            AND su."userId" IS NULL
         ON CONFLICT ("structureId", "userId") DO NOTHING
         RETURNING 1 AS inserted`,
        {
            replacements: { ownerRole: RoleCode.OWNER },
            type: QueryTypes.SELECT
        }
    );

    return inserted.length;
}

/** Rimuove vecchi override locali: OWNER deve essere effettivo in ogni sede. */
async function clearOwnerStructureOverrides(): Promise<number> {
    const result = await sequelize.query(
        `UPDATE structure_users su
            SET role = NULL,
                "updatedAt" = NOW()
           FROM tenant_users tu,
                structures s
          WHERE tu.role = :ownerRole
            AND s."tenantId" = tu."tenantId"
            AND su."userId" = tu."userId"
            AND su."structureId" = s.id
            AND su.role IS NOT NULL`,
        {
            replacements: { ownerRole: RoleCode.OWNER },
            type: QueryTypes.UPDATE
        }
    );

    return affectedRows(result);
}

/**
 * Bootstrap dei ruoli sulle membership già esistenti.
 *
 * Quando la colonna `tenant_users.role` viene creata, Postgres assegna a tutte le righe
 * esistenti il valore di default (`THERAPIST`). Senza questa correzione i titolari
 * si ritroverebbero senza accesso a fatturazione, utenti e dati azienda.
 *
 * Regola: chi è marcato come `users.isTenant = true` è il titolare => `OWNER`.
 *
 * Idempotente: agisce solo sulle righe rimaste al valore di default, quindi non
 * sovrascrive mai un ruolo assegnato deliberatamente dalla UI.
 */
export async function assignBootstrapRoles(): Promise<void> {
    // Prima si individua CHI è il titolare, altrimenti la promozione a OWNER qui sotto
    // non troverebbe alcuna riga su cui agire per gli studi registrati prima del fix.
    const marked = await markMissingTenantOwners();
    if (marked > 0) {
        console.log(`[rbac] individuato il titolare per ${marked} studi che ne erano privi`);
    }

    // `tenant_users` e `users` vivono nello schema public: nessun prefisso di schema necessario.
    const result = await sequelize.query(
        `UPDATE tenant_users tu
            SET role = :ownerRole
           FROM users u
          WHERE u.id = tu."userId"
            AND u."isTenant" = true
            AND tu.role = :defaultRole`,
        {
            replacements: { ownerRole: RoleCode.OWNER, defaultRole: DEFAULT_ROLE },
            type: QueryTypes.UPDATE
        }
    );

    const updated = affectedRows(result);
    if (updated > 0) {
        console.log(`[rbac] assegnato il ruolo OWNER a ${updated} membership di tenant`);
    }

    const assignedStructures = await assignOwnersToAllStructures();
    if (assignedStructures > 0) {
        console.log(`[rbac] assegnate ${assignedStructures} sedi mancanti ai proprietari`);
    }

    const clearedOverrides = await clearOwnerStructureOverrides();
    if (clearedOverrides > 0) {
        console.log(`[rbac] rimossi ${clearedOverrides} override locali dai proprietari`);
    }
}


