'use strict';
const VERSION = '20261009-structure-calendars';
module.exports = {
    async up(queryInterface) {
        const db = queryInterface.sequelize;
        await db.transaction(async transaction => {
            const query = sql => db.query(sql, {transaction});
            await query("SELECT pg_advisory_xact_lock(hashtext('rehablo-structure-calendars'))");
            await query("CREATE TABLE IF NOT EXISTS public.auth_schema_migrations (version VARCHAR(128) PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
            const [done] = await db.query('SELECT version FROM public.auth_schema_migrations WHERE version = :version', {transaction, replacements:{version: VERSION}});
            if (done.length) return;
            await query("ALTER TABLE public.structure_users ADD COLUMN IF NOT EXISTS \"calendarEnabled\" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN IF NOT EXISTS \"availabilityMode\" VARCHAR(32) NOT NULL DEFAULT 'INHERIT_STRUCTURE'");
            await query("CREATE TABLE IF NOT EXISTS public.structure_user_availabilities (id UUID PRIMARY KEY, \"userId\" UUID NOT NULL, \"structureId\" UUID NOT NULL, day INTEGER NOT NULL CHECK (day BETWEEN 0 AND 6), enabled BOOLEAN NOT NULL DEFAULT false, \"rangeOneStart\" TIME, \"rangeOneFinish\" TIME, \"rangeTwoStart\" TIME, \"rangeTwoFinish\" TIME, \"rangeThreeStart\" TIME, \"rangeThreeFinish\" TIME, \"rangeFourStart\" TIME, \"rangeFourFinish\" TIME, \"createdAt\" TIMESTAMPTZ NOT NULL, \"updatedAt\" TIMESTAMPTZ NOT NULL)");
            await query("CREATE UNIQUE INDEX IF NOT EXISTS structure_user_availability_day_unique ON public.structure_user_availabilities (\"userId\", \"structureId\", day)");
            // Do not choose an arbitrary weekday if legacy rows disagree. Original rows are retained.
            const [duplicates] = await query("SELECT \"userId\", day FROM public.user_availabilities GROUP BY \"userId\", day HAVING COUNT(*) > 1");
            if (duplicates.length) throw new Error('Disponibilita legacy duplicate: risolvere i giorni duplicati prima della migrazione delle agende');
            await query("UPDATE public.structure_users su SET \"calendarEnabled\" = true, \"availabilityMode\" = COALESCE(u.\"availabilityMode\", 'INHERIT_STRUCTURE') FROM public.users u WHERE u.id = su.\"userId\"");
            await query("INSERT INTO public.structure_user_availabilities (id, \"userId\", \"structureId\", day, enabled, \"rangeOneStart\", \"rangeOneFinish\", \"rangeTwoStart\", \"rangeTwoFinish\", \"rangeThreeStart\", \"rangeThreeFinish\", \"rangeFourStart\", \"rangeFourFinish\", \"createdAt\", \"updatedAt\") SELECT md5(su.\"userId\"::text || su.\"structureId\"::text || days.day::text)::uuid, su.\"userId\", su.\"structureId\", days.day, COALESCE(a.enabled,false), a.\"rangeOneStart\", a.\"rangeOneFinish\", a.\"rangeTwoStart\", a.\"rangeTwoFinish\", a.\"rangeThreeStart\", a.\"rangeThreeFinish\", a.\"rangeFourStart\", a.\"rangeFourFinish\", NOW(), NOW() FROM public.structure_users su CROSS JOIN generate_series(0,6) AS days(day) LEFT JOIN public.user_availabilities a ON a.\"userId\" = su.\"userId\" AND a.day = days.day ON CONFLICT (\"userId\", \"structureId\", day) DO NOTHING");
            await query("CREATE TABLE IF NOT EXISTS public.calendar_preferences (\"viewerUserId\" UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE, \"structureId\" UUID NOT NULL REFERENCES public.structures(id) ON DELETE CASCADE, \"calendarId\" UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE, \"createdAt\" TIMESTAMPTZ NOT NULL DEFAULT NOW(), \"updatedAt\" TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (\"viewerUserId\", \"structureId\", \"calendarId\"))");
            await query("ALTER TABLE public.structure_user_availabilities ADD CONSTRAINT structure_user_availability_membership_fk FOREIGN KEY (\"structureId\", \"userId\") REFERENCES public.structure_users (\"structureId\", \"userId\") ON DELETE CASCADE");
            await db.query('INSERT INTO public.auth_schema_migrations(version) VALUES (:version)', {transaction, replacements:{version: VERSION}});
        });
    },
    async down() { throw new Error('Le agende per sede contengono configurazioni indipendenti: rollback automatico non supportato'); }
};
