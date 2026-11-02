import { colorFor, initials } from '../lib/format.ts';

/** Colour + initials instead of a logo (logos are never uploaded). */
export function InstitutionAvatar({ name, color, size = 36 }: { name: string; color: string | null; size?: number }) {
  return (
    <span
      className="avatar-icon institution-avatar"
      aria-hidden
      style={{ background: color ?? colorFor(name), width: size, height: size, flexBasis: size, fontSize: Math.round(size * 0.4) }}
    >
      {initials(name.normalize('NFKC'))}
    </span>
  );
}
