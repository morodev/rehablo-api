import {createRequire} from 'node:module';
import type {Sequelize, Transaction} from 'sequelize';
import {quoteTenantSchema} from './migrationTypes.js';

const require = createRequire(import.meta.url);
export interface BaselineColumn {name: string; type: string; definition: string; nullable: boolean}
interface BaselineForeignKey {
    name: string; columns: string[]; targetSchema: string; targetTable: string; targetColumns: string[];
    onDelete: string; onUpdate: string; sql: string;
}
export interface BaselineTable {
    name: string; columns: BaselineColumn[]; enums: string[]; create: string;
    primaryKey: string[]; uniqueColumns: string[][];
    foreignKeys: BaselineForeignKey[]; indexes: Array<{name: string; sql: string}>;
}
export const schemaBaseline: {version: string; public: BaselineTable[]; tenant: BaselineTable[]} =
    require('../../migrations/baselines/20261028-schema.json');

const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const render = (sql: string, schema: string) => sql.replaceAll('__TENANT_SCHEMA__', schema);
function assertSchema(scope: 'public' | 'tenant', schema: string): void {
    if (scope === 'public' && schema !== 'public') throw new Error('The public baseline requires the public schema');
    if (scope === 'tenant') quoteTenantSchema(schema);
}

/** Canonical PostgreSQL spellings, retaining lengths, precision and schema-qualified enum identities. */
export function canonicalType(type: string): string {
    return type.toLowerCase().replaceAll('"', '').replace(/character varying/g, 'varchar')
        .replace(/timestamp with time zone/g, 'timestamptz').replace(/timestamp without time zone/g, 'timestamp')
        .replace(/time without time zone/g, 'time').replace(/double precision/g, 'float8')
        .replace(/decimal/g, 'numeric').replace(/serial/g, 'integer').replace(/\s+/g, '');
}

type ColumnRow = {tableName: string; columnName: string; type: string};
async function readColumns(schema: string, database: Sequelize, transaction?: Transaction): Promise<Map<string, ColumnRow>> {
    const [rows] = await database.query(`SELECT c.relname AS "tableName",a.attname AS "columnName",
        pg_catalog.format_type(a.atttypid,a.atttypmod) AS "type"
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=:schema AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped`,
        {transaction, replacements: {schema}});
    return new Map((rows as ColumnRow[]).map(row => [row.tableName + '.' + row.columnName, row]));
}

type ConstraintRow = {name: string; definition: string; tableName: string; kind: string; columns: string[]; targetSchema: string | null;
    targetTable: string | null; targetColumns: string[] | null; onDelete: string; onUpdate: string};
async function readConstraints(schema: string, database: Sequelize, transaction?: Transaction): Promise<ConstraintRow[]> {
    const [rows] = await database.query(`SELECT c.conname AS name,pg_get_constraintdef(c.oid) AS definition,
        t.relname AS "tableName",c.contype AS kind,
        ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num,ord)
            JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.ord) AS columns,
        rn.nspname AS "targetSchema",rt.relname AS "targetTable",
        ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num,ord)
            JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.ord) AS "targetColumns",
        c.confdeltype AS "onDelete",c.confupdtype AS "onUpdate"
        FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
        LEFT JOIN pg_class rt ON rt.oid=c.confrelid LEFT JOIN pg_namespace rn ON rn.oid=rt.relnamespace
        WHERE n.nspname=:schema AND c.contype IN ('p','u','f')`, {transaction, replacements: {schema}});
    return rows as ConstraintRow[];
}
const sameColumns = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
const actions: Record<string, string> = {'NO ACTION': 'a', RESTRICT: 'r', CASCADE: 'c', 'SET NULL': 'n', 'SET DEFAULT': 'd'};
/** Existing constraints retain their behavior; only variants evidenced by historical migrations are adopted. */
const legacyForeignKeys = [
    // cc78bbc required invoiceId; 07a1ff4 / 20260907 only removed NOT NULL, retaining CASCADE.
    {scope: 'tenant', table: 'invoice_payments', column: 'invoiceId', target: 'invoices',
        expectedDelete: 'SET NULL', expectedUpdate: 'CASCADE', onDelete: 'c', onUpdate: 'c'},
    // 20260901-create-patient-portal specified DELETE CASCADE but omitted UPDATE (PostgreSQL NO ACTION).
    ...[
        {table: 'user_emails', column: 'userId', target: 'users'},
        {table: 'patient_portal_accesses', column: 'userId', target: 'users'},
        {table: 'patient_portal_accesses', column: 'tenantId', target: 'tenants'},
        {table: 'patient_portal_invitations', column: 'tenantId', target: 'tenants'}
    ].map(key => ({...key, scope: 'public', expectedDelete: 'CASCADE', expectedUpdate: 'CASCADE', onDelete: 'c', onUpdate: 'a'}))
];
function matchesForeignKey(row: ConstraintRow, table: BaselineTable, foreignKey: BaselineForeignKey, schema: string): boolean {
    const sameReference = row.tableName === table.name && row.kind === 'f' && sameColumns(row.columns, foreignKey.columns)
        && row.targetSchema === render(foreignKey.targetSchema, schema) && row.targetTable === foreignKey.targetTable
        && sameColumns(row.targetColumns ?? [], foreignKey.targetColumns);
    if (!sameReference) return false;
    if (row.onDelete === actions[foreignKey.onDelete] && row.onUpdate === actions[foreignKey.onUpdate]) return true;
    return row.targetSchema === schema && sameColumns(foreignKey.targetColumns, ['id'])
        && legacyForeignKeys.some(key => key.scope === (schema === 'public' ? 'public' : 'tenant')
            && key.table === table.name && sameColumns(foreignKey.columns, [key.column]) && key.target === foreignKey.targetTable
            && key.expectedDelete === foreignKey.onDelete && key.expectedUpdate === foreignKey.onUpdate
            && key.onDelete === row.onDelete && key.onUpdate === row.onUpdate);
}

/** Compare index behavior rather than its legacy-generated name, avoiding duplicate equivalent indexes. */
export function canonicalIndex(sql: string): string {
    // Normalize SQL syntax only. Literal case/spacing and quoted mixed-case identifiers
    // change an index's meaning and must survive deparser normalization unchanged.
    const quoted: string[] = [];
    const protectedSql = sql.replace(/\bE'(?:\\[\s\S]|''|[^'\\])*'|'(?:''|[^'])*'|"(?:[^"]|"")*"/gi, token => {
        if (token.startsWith('"')) {
            const identifier = token.slice(1, -1).replaceAll('""', '"');
            // PostgreSQL can omit quotes around a simple lowercase identifier.
            if (/^[a-z_][a-z0-9_$]*$/.test(identifier)) return identifier;
        }
        quoted.push(/^[eE]'/.test(token) ? 'e' + token.slice(1) : token);
        // NUL cannot occur in PostgreSQL SQL text, so these temporary tokens cannot collide.
        return '\0' + (quoted.length - 1) + '\0';
    });
    const restore = (value: string) => value.replace(/\0(\d+)\0/g, (_match, index) => quoted[Number(index)]);
    const normalized = protectedSql.toLowerCase().replace(/^create (unique )?index (?:if not exists )?\S+ on /, '$1')
        .replace(/ using btree /, ' ');
    const position = normalized.indexOf(' where ');
    if (position < 0) return restore(normalized.replace(/[\s;]/g, ''));
    const keys = normalized.slice(0, position).replace(/[\s;]/g, '');
    let predicate = normalized.slice(position + 7)
        .replace(/::(?:text|character varying(?:\(\d+\))?|[a-z0-9_]+\.enum_[a-z0-9_]+)(?:\[\])?/g, '')
        .replace(/\b([a-z0-9_]+)\s*=\s*any\s*\(\s*array\[([^\]]*)\]\s*\)/g, '$1 in ($2)');
    // The frozen v1 partial indexes contain conjunctions of equality, IN and IS NULL only.
    // PostgreSQL adds grouping and renders IN as = ANY; grouping has no meaning for these predicates.
    // Preserve it for any future predicate using OR or a function.
    if (!/\bor\b|\b(?:not|coalesce|lower|upper)\s*\(/.test(predicate)) predicate = predicate.replace(/[()]/g, '');
    return restore(keys + 'where' + predicate.replace(/[\s;]/g, ''));
}

async function applyConstraints(scope: 'public' | 'tenant', schema: string, database: Sequelize, transaction: Transaction): Promise<void> {
    const constraints = await readConstraints(schema, database, transaction);
    const [rawIndexes] = await database.query('SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname=:schema',
        {transaction, replacements: {schema}});
    const indexes = rawIndexes as Array<{tablename: string; indexname: string; indexdef: string}>;
    for (const table of schemaBaseline[scope]) {
        const qualified = quote(schema) + '.' + quote(table.name);
        if (table.primaryKey.length && !constraints.some(row => row.tableName === table.name && row.kind === 'p'
            && sameColumns(row.columns, table.primaryKey))) {
            if (constraints.some(row => row.tableName === table.name && row.kind === 'p')) throw new Error(`Incompatible primary key: ${schema}.${table.name}`);
            await database.query(`ALTER TABLE ${qualified} ADD PRIMARY KEY (${table.primaryKey.map(quote).join(',')})`, {transaction});
        }
        for (const columns of table.uniqueColumns) {
            if (constraints.some(row => row.tableName === table.name && ['p','u'].includes(row.kind) && sameColumns(row.columns, columns))) continue;
            await database.query(`ALTER TABLE ${qualified} ADD UNIQUE (${columns.map(quote).join(',')})`, {transaction});
        }
        for (const foreignKey of table.foreignKeys) {
            const existing = constraints.filter(row => row.tableName === table.name && row.kind === 'f' && sameColumns(row.columns, foreignKey.columns));
            const incompatible = existing.filter(row => !matchesForeignKey(row, table, foreignKey, schema));
            if (incompatible.length) {
                throw new Error(`Incompatible foreign key: ${schema}.${table.name}(${foreignKey.columns.join(',')}); `
                    + `found ${incompatible.map(row => quote(row.name) + ': ' + row.definition).join('; ')}; `
                    + `expected REFERENCES ${render(foreignKey.targetSchema, schema)}.${foreignKey.targetTable}(${foreignKey.targetColumns.join(',')}) `
                    + `ON DELETE ${foreignKey.onDelete} ON UPDATE ${foreignKey.onUpdate} or a documented legacy variant; an explicit migration is required`);
            }
            if (existing.length) continue;
            await database.query(render(foreignKey.sql, schema), {transaction});
        }
        for (const index of table.indexes) {
            const sql = render(index.sql, schema);
            if (indexes.some(row => row.tablename === table.name && canonicalIndex(row.indexdef) === canonicalIndex(sql))) continue;
            if (indexes.some(row => row.tablename === table.name && row.indexname === index.name)) {
                throw new Error(`Incompatible index: ${schema}.${index.name}; an explicit migration is required`);
            }
            await database.query(sql, {transaction});
        }
    }
}

/** Frozen, one-time structural migration. Future model edits do not change this artifact. */
export async function applySchemaBaseline(
    scope: 'public' | 'tenant', schema: string, database: Sequelize, transaction: Transaction,
    options: {constraints?: boolean} = {}
): Promise<void> {
    assertSchema(scope, schema);
    if (scope === 'tenant') await database.query(`CREATE SCHEMA IF NOT EXISTS ${quote(schema)}`, {transaction});
    const columns = await readColumns(schema, database, transaction);
    for (const table of schemaBaseline[scope]) {
        const existing = table.columns.some(column => columns.has(table.name + '.' + column.name));
        const missing = table.columns.filter(column => !columns.has(table.name + '.' + column.name));
        if (missing.length) {
            for (const sql of table.enums) await database.query(render(sql, schema), {transaction});
        }
        if (!existing) {
            await database.query(render(table.create, schema), {transaction});
        } else {
            for (const column of missing) {
                await database.query(`ALTER TABLE ${quote(schema)}.${quote(table.name)} ADD COLUMN ${quote(column.name)} ${render(column.definition, schema)}`, {transaction});
            }
        }
    }
    await verifySchemaBaseline(scope, schema, database, transaction);
    if (options.constraints !== false) await applyConstraints(scope, schema, database, transaction);
}

/** Read-only structural check. It never infers or rewrites historical data. */
export async function verifySchemaBaseline(
    scope: 'public' | 'tenant', schema: string, database: Sequelize, transaction?: Transaction
): Promise<void> {
    assertSchema(scope, schema);
    const columns = await readColumns(schema, database, transaction);
    const failures: string[] = [];
    for (const table of schemaBaseline[scope]) {
        for (const column of table.columns) {
            const actual = columns.get(table.name + '.' + column.name);
            if (!actual) failures.push(`${table.name}.${column.name}: missing`);
            else {
                const expectedType = canonicalType(render(column.type, schema));
                let actualType = canonicalType(actual.type);
                // format_type omits public qualification when that schema is on search_path.
                if (expectedType.startsWith('public.enum_') && actualType.startsWith('enum_')) actualType = 'public.' + actualType;
                if (expectedType !== actualType) failures.push(`${table.name}.${column.name}: expected ${column.type}, found ${actual.type}`);
            }
        }
    }
    if (failures.length) throw new Error(`Schema baseline incompatible in ${schema}: ${failures.slice(0, 15).join('; ')}${failures.length > 15 ? `; and ${failures.length - 15} more` : ''}`);
}
