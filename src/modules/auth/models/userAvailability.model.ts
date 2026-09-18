import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../../../config/database.js';

export const USER_AVAILABILITY_TIME_COLUMNS = [
    'rangeOneStart',
    'rangeOneFinish',
    'rangeTwoStart',
    'rangeTwoFinish',
    'rangeThreeStart',
    'rangeThreeFinish',
    'rangeFourStart',
    'rangeFourFinish'
] as const;

export type UserAvailabilityTimeColumn = (typeof USER_AVAILABILITY_TIME_COLUMNS)[number];

export interface UserAvailabilityAttributes {
    id: string;
    day: number;
    enabled: boolean | null;
    rangeOneStart: string | null;
    rangeOneFinish: string | null;
    rangeTwoStart: string | null;
    rangeTwoFinish: string | null;
    rangeThreeStart: string | null;
    rangeThreeFinish: string | null;
    rangeFourStart: string | null;
    rangeFourFinish: string | null;
    userId: string;
}

export type UserAvailabilityCreationAttributes = Optional<UserAvailabilityAttributes, 'id'>;

export class UserAvailability
    extends Model<UserAvailabilityAttributes, UserAvailabilityCreationAttributes>
    implements UserAvailabilityAttributes {
    declare id: string;
    declare day: number;
    declare enabled: boolean | null;
    declare rangeOneStart: string | null;
    declare rangeOneFinish: string | null;
    declare rangeTwoStart: string | null;
    declare rangeTwoFinish: string | null;
    declare rangeThreeStart: string | null;
    declare rangeThreeFinish: string | null;
    declare rangeFourStart: string | null;
    declare rangeFourFinish: string | null;
    declare userId: string;
}

/** Sequelize muta la configurazione dell'attributo: ogni campo deve avere un oggetto distinto. */
function timeField(field: UserAvailabilityTimeColumn) {
    return { type: DataTypes.TIME, allowNull: true, field };
}

UserAvailability.init(
    {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true, unique: true },
        day: { type: DataTypes.INTEGER, allowNull: false },
        enabled: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: false },
        rangeOneStart: timeField('rangeOneStart'),
        rangeOneFinish: timeField('rangeOneFinish'),
        rangeTwoStart: timeField('rangeTwoStart'),
        rangeTwoFinish: timeField('rangeTwoFinish'),
        rangeThreeStart: timeField('rangeThreeStart'),
        rangeThreeFinish: timeField('rangeThreeFinish'),
        rangeFourStart: timeField('rangeFourStart'),
        rangeFourFinish: timeField('rangeFourFinish'),
        userId: { type: DataTypes.UUID, allowNull: false }
    },
    { sequelize, modelName: 'userAvailability', tableName: 'user_availabilities' }
);

export function missingUserAvailabilityTimeColumns(
    columns: Record<string, unknown>
): UserAvailabilityTimeColumn[] {
    return USER_AVAILABILITY_TIME_COLUMNS.filter((column) => !columns[column]);
}

/**
 * Ripara gli schemi creati dal vecchio modello, nel quale tutti gli attributi TIME
 * condividevano la stessa configurazione Sequelize e finivano su `rangeOneStart`.
 */
export async function syncUserAvailabilitySchema(): Promise<void> {
    // Crea la tabella completa nelle nuove installazioni; su una tabella esistente non altera nulla.
    await UserAvailability.sync();

    const queryInterface = sequelize.getQueryInterface();
    const columnsBefore = await queryInterface.describeTable('user_availabilities');
    const missingColumns = missingUserAvailabilityTimeColumns(columnsBefore);
    const requiredFinishWasMissing = missingColumns.includes('rangeOneFinish');

    if (missingColumns.length) {
        await sequelize.transaction(async (transaction) => {
            for (const column of missingColumns) {
                // I nomi arrivano dalla costante chiusa sopra, non da input esterno.
                await sequelize.query(
                    `ALTER TABLE "user_availabilities" ADD COLUMN IF NOT EXISTS "${column}" TIME`,
                    {transaction}
                );
            }

            if (requiredFinishWasMissing) {
                // La fine della prima fascia non è mai stata salvata: una giornata `enabled`
                // non è ricostruibile e va resa esplicitamente non disponibile.
                await sequelize.query(
                    `UPDATE "user_availabilities"
                     SET "enabled" = false,
                         "rangeOneStart" = NULL,
                         "rangeOneFinish" = NULL,
                         "rangeTwoStart" = NULL,
                         "rangeTwoFinish" = NULL,
                         "rangeThreeStart" = NULL,
                         "rangeThreeFinish" = NULL,
                         "rangeFourStart" = NULL,
                         "rangeFourFinish" = NULL,
                         "updatedAt" = NOW()
                     WHERE "enabled" = true`,
                    {transaction}
                );
            }
        });
    }

    const columnsAfter = await queryInterface.describeTable('user_availabilities');
    const stillMissing = missingUserAvailabilityTimeColumns(columnsAfter);
    if (stillMissing.length) {
        throw new Error(
            `Schema user_availabilities incompleto: mancano ${stillMissing.join(', ')}`
        );
    }
}

export default UserAvailability;

