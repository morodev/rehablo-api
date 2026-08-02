import { QueryTypes } from 'sequelize';
import { sequelize } from '../../../config/database.js';
import { DEFAULT_ROLE, RoleCode } from './roles.js';

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

    // Con QueryTypes.UPDATE Sequelize restituisce [rows, affectedCount].
    const updated = Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
    if (updated > 0) {
        console.log(`[rbac] assegnato il ruolo OWNER a ${updated} membership di tenant`);
    }
}


