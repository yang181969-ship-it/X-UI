import { appConfigSchema } from '@z-ui/shared';
import raw from '../../../../config/app.config.json' with { type: 'json' };

/** Defaults for a fresh installation; afterwards the config lives in the database. */
export const DEFAULT_CONFIG = appConfigSchema.parse(raw);
