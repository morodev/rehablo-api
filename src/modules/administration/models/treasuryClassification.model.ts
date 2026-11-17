import {DataTypes, Model} from 'sequelize';
import {sequelize} from '../../../config/database.js';

// Business metadata is separate from the append-only treasury ledger and its technical categories.
export class TreasuryCategory extends Model {}
TreasuryCategory.init({
    id: {type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4},
    name: {type: DataTypes.STRING(100), allowNull: false},
    normalizedName: {type: DataTypes.STRING(100), allowNull: false, unique: true},
    direction: {type: DataTypes.STRING(3), allowNull: false},
    color: {type: DataTypes.STRING(7), allowNull: false, defaultValue: '#6366f1'},
    isActive: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true},
}, {sequelize, modelName: 'treasuryCategory', tableName: 'treasury_categories'});

export class TreasuryTag extends Model {}
TreasuryTag.init({
    id: {type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4},
    name: {type: DataTypes.STRING(100), allowNull: false},
    normalizedName: {type: DataTypes.STRING(100), allowNull: false, unique: true},
    isActive: {type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true},
}, {sequelize, modelName: 'treasuryTag', tableName: 'treasury_tags'});

export class TreasuryClassification extends Model {}
TreasuryClassification.init({
    movementId: {type: DataTypes.UUID, primaryKey: true},
    businessCategoryId: {type: DataTypes.UUID, allowNull: true},
    updatedByUserId: {type: DataTypes.UUID, allowNull: false},
}, {sequelize, modelName: 'treasuryClassification', tableName: 'treasury_classifications'});

export class TreasuryMovementTag extends Model {}
TreasuryMovementTag.init({
    movementId: {type: DataTypes.UUID, primaryKey: true},
    tagId: {type: DataTypes.UUID, primaryKey: true},
}, {sequelize, modelName: 'treasuryMovementTag', tableName: 'treasury_movement_tags', timestamps: false});

export const TREASURY_CLASSIFICATION_MODELS = [TreasuryCategory, TreasuryTag, TreasuryClassification, TreasuryMovementTag];
