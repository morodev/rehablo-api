import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export interface WidgetAttributes {
    id: string;
    x: number;
    y: number;
    rows: number;
    cols: number;
    minItemRows?: number | null;
    maxItemRows?: number | null;
    minItemCols?: number | null;
    maxItemCols?: number | null;
    minItemArea?: number | null;
    maxItemArea?: number | null;
    layerIndex?: number | null;
    dragEnabled?: boolean | null;
    resizeEnabled?: boolean | null;
    compactEnabled?: boolean | null;
    resizableHandles?: Record<string, unknown> | null;
    widgetData?: Record<string, unknown> | null;
    dashboardId: string;
}

export type WidgetCreationAttributes = Optional<WidgetAttributes, 'id'>;

/** Tenant-scoped model: always access through `Widget.schema(req.tenantSchema)`. */
export class Widget extends Model<WidgetAttributes, WidgetCreationAttributes> implements WidgetAttributes {
    declare id: string;
    declare x: number;
    declare y: number;
    declare rows: number;
    declare cols: number;
    declare minItemRows: number | null;
    declare maxItemRows: number | null;
    declare minItemCols: number | null;
    declare maxItemCols: number | null;
    declare minItemArea: number | null;
    declare maxItemArea: number | null;
    declare layerIndex: number | null;
    declare dragEnabled: boolean | null;
    declare resizeEnabled: boolean | null;
    declare compactEnabled: boolean | null;
    declare resizableHandles: Record<string, unknown> | null;
    declare widgetData: Record<string, unknown> | null;
    declare dashboardId: string;
}

const optInt = { type: DataTypes.INTEGER, allowNull: true };
const optBool = { type: DataTypes.BOOLEAN, allowNull: true };

Widget.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        x: { type: DataTypes.INTEGER, allowNull: false },
        y: { type: DataTypes.INTEGER, allowNull: false },
        rows: { type: DataTypes.INTEGER, allowNull: false },
        cols: { type: DataTypes.INTEGER, allowNull: false },
        minItemRows: optInt,
        maxItemRows: optInt,
        minItemCols: optInt,
        maxItemCols: optInt,
        minItemArea: optInt,
        maxItemArea: optInt,
        layerIndex: optInt,
        dragEnabled: optBool,
        resizeEnabled: optBool,
        compactEnabled: optBool,
        resizableHandles: { type: DataTypes.JSON, allowNull: true },
        widgetData: { type: DataTypes.JSON, allowNull: true },
        dashboardId: { type: DataTypes.UUID, allowNull: false }
    },
    { sequelize, modelName: 'widget', tableName: 'widgets' }
);

export default Widget;

