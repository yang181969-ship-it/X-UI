import { Avatar } from 'antd';
import type { UserDto } from '@z-ui/shared';
import { colorFor, initials } from '../lib/format.ts';

/** The user's picture, or their initials on a stable color. */
export function UserAvatar({ user, size }: { user: Pick<UserDto, 'username' | 'displayName' | 'avatar'> | undefined; size?: number }) {
  if (user?.avatar) return <Avatar src={user.avatar} size={size} alt={user.displayName} />;
  return (
    <Avatar size={size} style={{ background: colorFor(user?.username ?? '') }}>
      {initials(user?.displayName ?? '')}
    </Avatar>
  );
}

/**
 * Square-crop and shrink an image file to a small data URL (WebP, JPEG where WebP encoding is
 * unsupported). Done in the browser so only a few KB reach the database.
 */
export async function avatarFromFile(file: File, edge = 192): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('not an image'));
      el.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = edge;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, edge, edge);
    const webp = canvas.toDataURL('image/webp', 0.85);
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}
