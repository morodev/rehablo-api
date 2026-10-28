'use strict';

require('dotenv').config();
const {Sequelize} = require('sequelize');

// Parse through Sequelize exactly as the application does, including encoded credentials
// and PostgreSQL URL options. Construction opens no database connection.
const database = new Sequelize(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/rehablo', {
    dialect: 'postgres',
    protocol: 'postgres',
    dialectOptions: {
        ssl: process.env.DB_SSL === 'true' ? {require: true, rejectUnauthorized: false} : false
    },
    pool: {max: 5, min: 0, acquire: 30000, idle: 10000},
    logging: false
});

// Export parsed fields, so the CLI cannot reparse the URL with different option handling.
module.exports = {
    dialect: database.getDialect(),
    protocol: database.config.protocol,
    host: database.config.host,
    port: database.config.port,
    database: database.config.database,
    username: database.config.username,
    password: database.config.password,
    dialectOptions: database.options.dialectOptions,
    pool: database.options.pool,
    logging: false,
    migrationStorage: 'sequelize',
    migrationStorageTableName: 'SequelizeMeta',
    migrationStorageTableSchema: 'public'
};
