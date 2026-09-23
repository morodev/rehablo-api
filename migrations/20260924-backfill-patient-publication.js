/** Existing portal-visible clinical records remain visible after explicit publication is introduced. */
module.exports = { async up(queryInterface, { schema, transaction }) {
    if (!/^rehablo_[a-f0-9]{32}$/i.test(schema)) throw new Error('Invalid tenant schema');
    await queryInterface.sequelize.query(
        `UPDATE "${schema}"."evaluations" SET "publishedToPatient" = true WHERE "status" = 'COMPLETED'`,
        { transaction }
    );
    await queryInterface.sequelize.query(
        `UPDATE "${schema}"."protocol_instances" SET "publishedToPatient" = true`,
        { transaction }
    );
} };
