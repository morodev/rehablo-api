import { User, UserEmail } from '../models/index.js';
import { normalizeIdentityEmail } from '../models/userEmail.model.js';

/** Trova un'identità da email primaria o alias, senza rivelare a quale tenant appartenga. */
export async function findUserByIdentityEmail(email: unknown): Promise<User | null> {
    const normalizedEmail = normalizeIdentityEmail(email);
    if (!normalizedEmail) return null;

    const alias = await UserEmail.findOne({ where: { normalizedEmail } });
    if (alias) {
        return User.findByPk(alias.get('userId') as string);
    }

    // Compatibilità durante il backfill iniziale.
    return User.findOne({ where: { email: normalizedEmail } });
}
/**
 * Aggiunge l'indirizzo provato dal token di invito all'account scelto dal paziente.
 * Se l'alias appartiene già a un'altra identità non viene mai spostato implicitamente.
 */
export async function attachVerifiedEmailAlias(userId: string, email: string): Promise<'attached' | 'owned' | 'conflict'> {
    const normalizedEmail = normalizeIdentityEmail(email);
    if (!normalizedEmail) return 'conflict';

    const existing = await UserEmail.findOne({ where: { normalizedEmail } });
    if (existing) {
        if ((existing.get('userId') as string) !== userId) return 'conflict';
        if (!existing.get('verifiedAt')) await existing.update({ verifiedAt: new Date() });
        return 'owned';
    }

    await UserEmail.create({
        userId,
        email: email.trim(),
        normalizedEmail,
        isPrimary: false,
        verifiedAt: new Date()
    });
    return 'attached';
}
