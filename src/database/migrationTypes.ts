import type {Sequelize, Transaction} from 'sequelize';

export interface MigrationStep {
    name: string;
    scope: 'public' | 'tenant';
    checksum: string;
    up(database: Sequelize, schema: string, transaction: Transaction): Promise<void>;
}

export interface DatabaseManifest {
    id: string;
    checksum: string;
    publicMigrations: MigrationStep[];
    tenantMigrations: MigrationStep[];
}

export class SchemaReadinessError extends Error {
    readonly status = 503;
    readonly statusCode = 503;
    readonly code = 'DATABASE_SCHEMA_NOT_READY';
}

export function quoteTenantSchema(schema: string): string {
    if (!/^rehablo_[a-f0-9]{32}$/i.test(schema)) throw new Error('Invalid tenant schema');
    return '"' + schema + '"';
}

export function validateManifest(manifest: DatabaseManifest): void {
    if (!manifest.id || manifest.id.length > 160 || !manifest.checksum) throw new Error('Invalid database release manifest');
    for (const [scope, steps] of [['public', manifest.publicMigrations], ['tenant', manifest.tenantMigrations]] as const) {
        const names = new Set<string>();
        for (const step of steps) {
            if (step.scope !== scope || !step.name || step.name.length > 160 || !step.checksum || typeof step.up !== 'function') {
                throw new Error(`Invalid ${scope} migration in release ${manifest.id}`);
            }
            if (names.has(step.name)) throw new Error(`Duplicate ${scope} migration: ${step.name}`);
            names.add(step.name);
        }
    }
}

export function manifestRecord(manifest: DatabaseManifest): object {
    return {
        publicMigrations: manifest.publicMigrations.map(({name, checksum}) => ({name, checksum})),
        tenantMigrations: manifest.tenantMigrations.map(({name, checksum}) => ({name, checksum}))
    };
}
