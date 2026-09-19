import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface ServiceStructureAttributes {
    serviceId: string;
    structureId: string;
}

export class ServiceStructure extends Model<ServiceStructureAttributes> implements ServiceStructureAttributes {
    declare serviceId: string;
    declare structureId: string;
}

ServiceStructure.init(
    {
        serviceId: { type: DataTypes.UUID, allowNull: false, primaryKey: true },
        structureId: { type: DataTypes.UUID, allowNull: false, primaryKey: true }
    },
    {
        sequelize,
        modelName: 'serviceStructure',
        tableName: 'service_structures',
        indexes: [{name: 'service_structures_structure_id', fields: ['structureId']}]
    }
);

export default ServiceStructure;
