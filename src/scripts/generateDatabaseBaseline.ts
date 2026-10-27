/**
 * Developer tool: freezes reviewed model definitions into an explicit migration artifact.
 * It never authenticates or queries a database. Do not run this during build/deploy.
 * Existing baselines are immutable; pass a NEW --output filename for a subsequent baseline.
 */
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {sequelize} from '../config/database.js';
import {registerDatabaseModels} from '../database/registerModels.js';
import {getTenantScopedModels} from '../utils/tenantSchema.js';

registerDatabaseModels();
const outputIndex = process.argv.indexOf('--output');
if (outputIndex < 0 || !process.argv[outputIndex + 1]) throw new Error('Specify a new baseline filename with --output.');
const generator = sequelize.getQueryInterface().queryGenerator as any;
const tenantModels = new Set(getTenantScopedModels());
const tenantTables = new Set([...tenantModels].map(model => model.tableName));
const identifier = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const constraintName = (value: string) => Buffer.byteLength(value) <= 63 ? value
    : value.slice(0, 49) + '_' + createHash('sha256').update(value).digest('hex').slice(0, 12);

function snapshot(model: any, scope: 'public' | 'tenant') {
    const schema = scope === 'tenant' ? '__TENANT_SCHEMA__' : 'public';
    const tableName = model.tableName;
    const table = {tableName, schema};
    const columns: any[] = [], enums: string[] = [], foreignKeys: any[] = [];
    const attributes: Record<string, string> = {};
    const uniqueColumns: string[][] = [];
    for (const [attributeName, raw] of Object.entries(model.getAttributes()) as Array<[string, any]>) {
        const field = raw.field || attributeName;
        const attribute = {...raw};
        delete attribute.references;
        delete attribute.comment;
        const definition = generator.attributeToSQL(attribute, {table, key: field});
        attributes[field] = definition;
        const type = generator.dataTypeMapping(table, field,
            generator.attributeToSQL({type: attribute.type}, {table, key: field}));
        const addDefinition = generator.dataTypeMapping(table, field,
            generator.attributeToSQL({...attribute, primaryKey: false, unique: false}, {table, key: field}));
        columns.push({name: field, type, definition: addDefinition, nullable: raw.allowNull !== false && !raw.primaryKey});
        if (attribute.type.key === 'ENUM' || attribute.type.type?.key === 'ENUM') {
            enums.push(generator.pgEnum(table, field, attribute.type.type || attribute.type));
        }
        if (raw.unique === true && !raw.primaryKey) uniqueColumns.push([field]);
        if (raw.references) {
            const referenced = raw.references.model;
            const targetTable = typeof referenced === 'string' ? referenced : referenced.tableName;
            const targetSchema = scope === 'tenant' && tenantTables.has(targetTable) ? schema : 'public';
            const name = constraintName(tableName + '_' + field + '_fkey');
            const targetField = raw.references.key || 'id';
            const onDelete = (raw.onDelete || 'NO ACTION').toUpperCase();
            const onUpdate = (raw.onUpdate || 'NO ACTION').toUpperCase();
            foreignKeys.push({name, columns: [field], targetSchema, targetTable, targetColumns: [targetField], onDelete, onUpdate,
                sql: `ALTER TABLE ${identifier(schema)}.${identifier(tableName)} ADD CONSTRAINT ${identifier(name)} FOREIGN KEY (${identifier(field)}) REFERENCES ${identifier(targetSchema)}.${identifier(targetTable)} (${identifier(targetField)}) ON DELETE ${onDelete} ON UPDATE ${onUpdate};`});
        }
    }
    for (const key of Object.values(model.uniqueKeys || {}) as any[]) {
        if (key.fields?.length && !uniqueColumns.some(fields => JSON.stringify(fields) === JSON.stringify(key.fields))) uniqueColumns.push(key.fields);
    }
    const indexes = (model.options.indexes || []).map((options: any) => {
        const copy = {...options};
        const sql = generator.addIndexQuery(table, copy, tableName);
        return {name: copy.name, sql};
    });
    return {name: tableName, columns, enums, foreignKeys, indexes, uniqueColumns,
        primaryKey: Object.values(model.getAttributes()).filter((attr: any) => attr.primaryKey).map((attr: any) => attr.field || attr.fieldName),
        create: generator.createTableQuery(table, {...attributes}, {uniqueKeys: model.uniqueKeys})};
}

const models = Object.values(sequelize.models);
const baseline = {
    version: '20261028-explicit-schema-baseline-v1',
    public: models.filter(model => !tenantModels.has(model)).map(model => snapshot(model, 'public')),
    tenant: [...tenantModels].map(model => snapshot(model, 'tenant'))
};
writeFileSync(resolve(process.argv[outputIndex + 1]), JSON.stringify(baseline, null, 2) + '\n', {flag: 'wx'});
console.log(`Frozen ${baseline.public.length} public and ${baseline.tenant.length} tenant tables. No database was accessed.`);
