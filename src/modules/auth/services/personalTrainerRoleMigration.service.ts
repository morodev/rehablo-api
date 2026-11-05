import { QueryTypes, type Sequelize, type Transaction } from 'sequelize';

/** Add enum labels before any transaction inserts PT memberships. Existing roles remain unchanged. */
export async function ensurePersonalTrainerRoleEnum(database: Sequelize, transaction?: Transaction): Promise<void> {
    const types=await database.query<{schema_name:string;type_name:string}>(`
        SELECT n.nspname AS schema_name,t.typname AS type_name
        FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
        WHERE t.typtype='e' AND n.nspname='public'
        AND t.typname IN ('enum_tenant_users_role','enum_structure_users_role')
    `,{type:QueryTypes.SELECT,transaction});
    for(const type of types){
        const quote=(value:string)=>'"'+value.replace(/"/g,'""')+'"';
        await database.query('ALTER TYPE '+quote(type.schema_name)+'.'+quote(type.type_name)+" ADD VALUE IF NOT EXISTS 'PERSONAL_TRAINER'",{transaction});
    }
}
