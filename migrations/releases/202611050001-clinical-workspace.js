'use strict';
module.exports = {
 async up(queryInterface) {const {migrateClinicalWorkspace}=await import('../../dist/database/standardMigrations.js');await migrateClinicalWorkspace(queryInterface.sequelize);},
 async down() {throw new Error('Clinical history and assigned roles must be retained. Use a reviewed corrective migration.');}
};
