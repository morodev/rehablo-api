import {createRequire} from 'node:module';
import type {MigrationStep} from './migrationTypes.js';

const require = createRequire(import.meta.url);
/** The executable migration and its catalog inputs are immutable, shared by source and compiled runtimes. */
export function publicMigrationSteps(): MigrationStep[] {
    return require('../../migrations/20261028-public-bootstrap.js').publicMigrationSteps();
}
